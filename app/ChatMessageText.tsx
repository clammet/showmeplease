import { linkifyChatText } from "@/lib/chatLinks";

export default function ChatMessageText({ text, tabIndex }: { text: string; tabIndex?: number }) {
  return linkifyChatText(text).map((part, index) => part.href ? (
    <a
      key={index}
      href={part.href}
      target="_blank"
      rel="noopener noreferrer"
      title="Opens in a new tab"
      tabIndex={tabIndex}
    >
      {part.text}
    </a>
  ) : part.text);
}
