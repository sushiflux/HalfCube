// Small pure helpers of the update views: sizes, the time of the last check.
import { useState } from "react";
import type { Language } from "../i18n/types.ts";

const decimal = (n: number, language: Language): string => (language === "de" ? n.toFixed(1).replace(".", ",") : n.toFixed(1));

/** "18,4 MB" / "18.4 MB"; below one megabyte in KB. */
export function formatSize(bytes: number, language: Language): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${decimal(bytes / (1024 * 1024), language)} MB`;
}

/** "7,7 / 18,4 MB" while a download runs. */
export function formatProgressSize(received: number, total: number, language: Language): string {
  const mb = (n: number) => decimal(n / 1048576, language);
  return `${mb(Math.min(received, total))} / ${mb(total)} MB`;
}

export type WhenKey = "updates.whenToday" | "updates.whenYesterday" | "updates.whenDate";

export interface When {
  key: WhenKey;
  params: { time: string; date: string };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The date as the UI language writes it: "27.11.2026" in German, "2026-11-27" in English. */
function formatDate(year: number, month: number, day: number, language: Language): string {
  return language === "de" ? `${pad(day)}.${pad(month)}.${year}` : `${year}-${pad(month)}-${pad(day)}`;
}

/** An ISO date ("2026-11-27", as the changelog headings carry it) in the UI language; null when it is not one. */
export function formatIsoDate(iso: string, language: Language): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? formatDate(Number(m[1]), Number(m[2]), Number(m[3]), language) : null;
}

/** The time of a check as the key and parameters of a message ("heute, 14:32", "gestern, 09:05", "24.11.2026, 18:20"). */
export function describeWhen(iso: string, now: Date, language: Language): When | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const date = formatDate(at.getFullYear(), at.getMonth() + 1, at.getDate(), language);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  if (days === 0) return { key: "updates.whenToday", params: { time, date } };
  if (days === 1) return { key: "updates.whenYesterday", params: { time, date } };
  return { key: "updates.whenDate", params: { time, date } };
}

/** The time when the view was built: "today" and "yesterday" are measured from it. */
export function useNow(): Date {
  return useState(() => new Date())[0];
}
