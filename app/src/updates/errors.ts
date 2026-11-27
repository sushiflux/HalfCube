// The complete, copyable text of an update error: a specific headline with the code, an explanation and the technical cause.
import type { MessageKey, MessageParams } from "../i18n/types.ts";
import type { ErrorBlock } from "../ui/errorText.ts";
import type { UpdateError } from "./types.ts";

type Translate = (key: MessageKey, params?: MessageParams) => string;

const headlineKeys = {
  "HC-UPDATE-001": "updates.errorHeadline1",
  "HC-UPDATE-002": "updates.errorHeadline2",
  "HC-UPDATE-003": "updates.errorHeadline3",
  "HC-UPDATE-004": "updates.errorHeadline4",
} as const satisfies Record<UpdateError["code"], MessageKey>;

const textKeys = {
  "HC-UPDATE-001": "updates.errorText1",
  "HC-UPDATE-002": "updates.errorText2",
  "HC-UPDATE-003": "updates.errorText3",
  "HC-UPDATE-004": "updates.errorText4",
} as const satisfies Record<UpdateError["code"], MessageKey>;

export interface UpdateErrorView {
  headline: string;
  code: string;
  details: ErrorBlock[];
  occurredAt: Date;
}

/** The error as the notice shows it. The untranslated technical cause stays as it came, followed by the channel. */
export function describeUpdateError(error: UpdateError, t: Translate, channel: string): UpdateErrorView {
  const at = new Date(error.at);
  return {
    headline: t(headlineKeys[error.code]),
    code: error.code,
    details: [
      { kind: "text", text: t(textKeys[error.code]) },
      { kind: "code", text: `${error.detail}\n${t("updates.errorMeta", { channel })}` },
    ],
    occurredAt: Number.isNaN(at.getTime()) ? new Date() : at,
  };
}
