import { CodingTools, createCodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { logWarn } from "../logging";

export type CodingExtension = ReturnType<typeof createCodingTools>;

/**
 * `read` returns text or one image. With a Photon processor it orients, converts and shrinks images to the model's
 * image limits; without one, supported images within the inline limits still pass through as they are.
 */
export async function createPikoCodingTools(): Promise<CodingExtension> {
  try {
    return createCodingTools({ images: await createNodePhotonImages() });
  } catch {
    logWarn("images.processor.unavailable");
    return CodingTools;
  }
}

/** Memory review edits files directly; a shell is not needed to maintain two Markdown paths. */
export function curatorTools(coding: CodingExtension) {
  return (coding.tools ?? []).filter(tool => tool.name !== "bash");
}
