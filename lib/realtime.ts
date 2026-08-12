export type CodecPreference = "auto" | "AV1" | "VP9" | "VP8" | "H264";

export type SessionOptions = {
  codec: CodecPreference;
  maxBitrateKbps: number;
  frameRate: 15 | 30 | 60;
  includeSystemAudio: boolean;
  allowViewerMic: boolean;
};

export type SharedTrack = {
  sessionId: string;
  trackName: string;
  kind: "audio" | "video";
  source: "screen" | "presenter-mic" | "viewer-mic";
  ownerId?: string;
};

type TrackApiResponse = {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: RTCSessionDescriptionInit;
  tracks?: Array<{ trackName: string; mid?: string }>;
};

type RealtimeConnectionOptions = {
  code: string;
  token: string;
  preferences: SessionOptions;
  onRemoteStream?: (stream: MediaStream) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
};

const REALTIME_HEADERS = (code: string, token: string) => ({
  "content-type": "application/json",
  "x-session-code": code,
  "x-session-token": token,
});

async function apiRequest<T>(
  path: string,
  method: "POST" | "PUT",
  code: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: REALTIME_HEADERS(code, token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    detail?: string;
  };

  if (!response.ok) {
    throw new Error(payload.detail || payload.error || "Realtime request failed");
  }

  return payload;
}

function setCodecPreference(
  transceiver: RTCRtpTransceiver,
  preference: CodecPreference,
) {
  if (preference === "auto" || !transceiver.setCodecPreferences) return;
  const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
  const mime = `video/${preference.toLowerCase()}`;
  const preferred = codecs.filter(
    (codec) => codec.mimeType.toLowerCase() === mime,
  );
  if (!preferred.length) return;
  const rest = codecs.filter((codec) => !preferred.includes(codec));
  transceiver.setCodecPreferences([...preferred, ...rest]);
}

export class RealtimeConnection {
  private peer: RTCPeerConnection | null = null;
  private sessionId: string | null = null;
  private remoteStream = new MediaStream();
  private operation: Promise<unknown> = Promise.resolve();
  private readonly code: string;
  private readonly token: string;
  private preferences: SessionOptions;
  private readonly onRemoteStream?: (stream: MediaStream) => void;
  private readonly onConnectionState?: (state: RTCPeerConnectionState) => void;

  constructor(options: RealtimeConnectionOptions) {
    this.code = options.code;
    this.token = options.token;
    this.preferences = options.preferences;
    this.onRemoteStream = options.onRemoteStream;
    this.onConnectionState = options.onConnectionState;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operation.then(task, task);
    this.operation = result.catch(() => undefined);
    return result;
  }

  private async ensureSession() {
    if (this.peer && this.sessionId) {
      return { peer: this.peer, sessionId: this.sessionId };
    }

    const created = await apiRequest<{ sessionId: string }>(
      "/api/realtime/sessions/new",
      "POST",
      this.code,
      this.token,
    );

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle",
    });

    peer.addEventListener("track", (event) => {
      if (!this.remoteStream.getTrackById(event.track.id)) {
        this.remoteStream.addTrack(event.track);
      }
      event.track.addEventListener("ended", () => {
        this.remoteStream.removeTrack(event.track);
      });
      this.onRemoteStream?.(this.remoteStream);
    });
    peer.addEventListener("connectionstatechange", () => {
      this.onConnectionState?.(peer.connectionState);
    });

    this.peer = peer;
    this.sessionId = created.sessionId;
    return { peer, sessionId: created.sessionId };
  }

  async publishTracks(
    tracks: Array<{ track: MediaStreamTrack; source: SharedTrack["source"] }>,
  ): Promise<SharedTrack[]> {
    return this.enqueue(async () => {
      const { peer, sessionId } = await this.ensureSession();
      const additions = tracks.map(({ track, source }) => {
        const transceiver = peer.addTransceiver(track, {
          direction: "sendonly",
          streams: [new MediaStream([track])],
        });
        if (track.kind === "video") {
          setCodecPreference(transceiver, this.preferences.codec);
        }
        return {
          transceiver,
          track,
          source,
          trackName: `${source}-${crypto.randomUUID()}`,
        };
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      const response = await apiRequest<TrackApiResponse>(
        `/api/realtime/sessions/${sessionId}/tracks/new`,
        "POST",
        this.code,
        this.token,
        {
          sessionDescription: peer.localDescription?.toJSON(),
          tracks: additions.map(({ transceiver, trackName }) => ({
            location: "local",
            mid: transceiver.mid,
            trackName,
          })),
        },
      );

      if (!response.sessionDescription) {
        throw new Error("Cloudflare did not return a session answer");
      }
      await peer.setRemoteDescription(response.sessionDescription);
      await this.applyBitrate(this.preferences.maxBitrateKbps);

      return additions.map(({ track, source, trackName }) => ({
        sessionId,
        trackName,
        kind: track.kind as "audio" | "video",
        source,
      }));
    });
  }

  async pullTracks(tracks: SharedTrack[]): Promise<void> {
    if (!tracks.length) return;
    await this.enqueue(async () => {
      const { peer, sessionId } = await this.ensureSession();
      const response = await apiRequest<TrackApiResponse>(
        `/api/realtime/sessions/${sessionId}/tracks/new`,
        "POST",
        this.code,
        this.token,
        {
          tracks: tracks.map((track) => ({
            location: "remote",
            sessionId: track.sessionId,
            trackName: track.trackName,
          })),
        },
      );

      if (response.requiresImmediateRenegotiation) {
        if (!response.sessionDescription) {
          throw new Error("Cloudflare did not return a session offer");
        }
        await peer.setRemoteDescription(response.sessionDescription);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await apiRequest(
          `/api/realtime/sessions/${sessionId}/renegotiate`,
          "PUT",
          this.code,
          this.token,
          { sessionDescription: peer.localDescription?.toJSON() },
        );
      } else if (response.sessionDescription) {
        await peer.setRemoteDescription(response.sessionDescription);
      }
    });
  }

  async updatePreferences(preferences: SessionOptions) {
    this.preferences = preferences;
    await this.applyBitrate(preferences.maxBitrateKbps);
  }

  async applyBitrate(maxBitrateKbps: number) {
    if (!this.peer) return;
    await Promise.all(
      this.peer.getSenders().map(async (sender) => {
        if (sender.track?.kind !== "video") return;
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = maxBitrateKbps * 1000;
        await sender.setParameters(parameters);
      }),
    );
  }

  close() {
    this.peer?.close();
    this.peer = null;
    this.sessionId = null;
    this.remoteStream.getTracks().forEach((track) => track.stop());
    this.remoteStream = new MediaStream();
  }
}
