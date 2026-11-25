import {
  defineDoc,
  type ConversationId,
  type EntryId,
} from "@earendil-works/pi-durable";
import type { InputSource } from "../types";

export const JobControl = defineDoc<{ epoch: number; reported: number[]; lastActivityAt?: number }>({
  kind: "piko.subagent-control",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ epoch: 0, reported: [] }),
});
/** Product provenance and reporting policy, never execution state or a second agent configuration. */
export type BackgroundJobPolicy = {
  kind: string;
  title?: string;
  continuable: boolean;
  report: { heading: string; deliver: "origin" | "all" };
};
export const BackgroundJob = defineDoc<{ policy: BackgroundJobPolicy | null }>({
  kind: "piko.background-job", version: 1, scope: "conversation", history: "latest", fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ policy: null }),
});
export const ANCHOR_KIND = "piko.subagent-anchor";
export const REPORTER_KIND = "piko.subagent-reporter";

export type ReporterInput = {
  child: ConversationId;
  message: string;
  epoch: number;
  source: InputSource;
};
export type ReporterState =
  | { phase: "deliver" }
  | { phase: "report"; answer?: EntryId; error?: string }
  | { phase: "retry"; answer?: EntryId; error?: string };
export type ReporterResult = { answer?: EntryId; error?: string } | null;
