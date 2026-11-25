import type { FilePreviewKind } from "./file-preview";

export type ArtifactEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number | null;
  modifiedAt: number;
  preview: FilePreviewKind | null;
};

export type ArtifactDirectory = {
  path: string;
  entries: ArtifactEntry[];
};

export type ArtifactTextPreview = {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
  preview: FilePreviewKind;
};

export type ArtifactDeletion = {
  path: string;
  kind: "directory" | "file";
};
