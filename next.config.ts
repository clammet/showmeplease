import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The frontend is a static export; the Node backend (server/) serves it and
  // handles /api.
  output: "export",
};

export default nextConfig;
