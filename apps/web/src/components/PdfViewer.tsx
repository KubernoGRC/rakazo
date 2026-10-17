import { EMBEDDED_FRAMES_ENABLED } from "../lib/browser-controls";
import { useObjectUrl } from "../lib/use-object-url";
import { EmbeddedContentDisabled } from "./EmbeddedContentDisabled";

export function PdfViewer({ bytes, title }: { bytes: Uint8Array; title: string }) {
  // Fork: see docs/fork-browser-controls.md.
  if (!EMBEDDED_FRAMES_ENABLED) return <EmbeddedContentDisabled />;
  return <PdfFrame bytes={bytes} title={title} />;
}

function PdfFrame({ bytes, title }: { bytes: Uint8Array; title: string }) {
  const url = useObjectUrl(bytes, "application/pdf");
  if (!url) return null;
  return <iframe title={title} src={url} className="h-full w-full border-0" />;
}
