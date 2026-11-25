// Dev-only demo scenes (opened with ?demo=<name> in the dev channel, see dev/params.ts). Loaded lazily, so no other
// channel ever fetches this code.
import { useMemo, useState } from "react";
import { i18n, useI18n } from "../i18n/runtime.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { useConfirm } from "../ui/Confirm.tsx";
import { ErrorNotice } from "../ui/ErrorNotice.tsx";
import { Field } from "../ui/Field.tsx";
import { LoadingPanel } from "../ui/loading/LoadingPanel.tsx";
import { LoadingScreen } from "../ui/loading/LoadingScreen.tsx";
import { maxLength, minLength, repeatOf, required } from "../ui/rules.ts";
import { Toggle } from "../ui/Toggle.tsx";
import { themeStore, useTheme } from "../theme/runtime.ts";
import { themeKeys } from "../theme/themes.ts";
import { buildScenario } from "./scenarios.ts";
import { useScenario } from "./useScenario.ts";

export function DemoStartup({ name, onDone }: { name: string; onDone: () => void }) {
  const { language } = useI18n();
  const scenario = useMemo(() => buildScenario(name, language), [name, language]);
  const progress = useScenario(scenario);
  return (
    <LoadingScreen
      progress={progress}
      onHandoverDone={onDone}
      onAction={(id) => {
        if (id === "retry" || id === "reload") location.reload();
      }}
    />
  );
}

export function DemoPanel({ name }: { name: string }) {
  const { language } = useI18n();
  const scenario = useMemo(() => buildScenario(name, language), [name, language]);
  const progress = useScenario(scenario);
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  return (
    <LoadingPanel
      progress={progress}
      {...(scenario?.cancellable || progress.error ? { onCancel: () => setClosed(true) } : {})}
      onAction={() => setClosed(true)}
    />
  );
}

export function DemoCrash(): never {
  throw new Error("Demo crash: this error was thrown on purpose while rendering to show the crash page.");
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h2 className="mb-3 text-[11.5px] font-semibold tracking-[0.16em] text-primary uppercase">{title}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** All shared components in one place, with a theme/mode/language switch for looking at every combination. */
export function DemoGallery() {
  const { theme, mode } = useTheme();
  const { language } = useI18n();
  const confirm = useConfirm();
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [checked, setChecked] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState("");

  return (
    <div className="h-full overflow-auto bg-bg p-4 text-fg">
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="gallery-switch">
        {themeKeys.map((key) => (
          <Button key={key} size="md" variant={key === theme ? "primary" : "neutral"} onClick={() => themeStore.setTheme(key)}>
            {key}
          </Button>
        ))}
        <Button onClick={() => themeStore.setMode(mode === "light" ? "dark" : "light")}>{mode}</Button>
        <Button onClick={() => i18n.setLanguage(language === "de" ? "en" : "de")}>{language}</Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-4">
        <Section title="Buttons">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary">Primary</Button>
            <Button variant="create">Create</Button>
            <Button variant="destructive">Destructive</Button>
            <Button>Neutral</Button>
            <Button variant="quiet">Quiet</Button>
            <Button disabled>Disabled</Button>
            <Button variant="primary" loading={loading} onClick={() => { setLoading(true); window.setTimeout(() => setLoading(false), 1500); }}>
              Loading
            </Button>
          </div>
        </Section>
        <Section title="Toggle and checkbox">
          <Toggle checked={on} onChange={setOn} label="Switched on" />
          <Toggle checked={off} onChange={setOff} label="Switched off" />
          <Checkbox checked={checked} onChange={setChecked} label="A checkbox" />
        </Section>
        <Section title="Fields with live validation">
          <Field label="Name" value={name} onChange={setName} rules={[required(), minLength(8), maxLength(20)]} submitAttempted={submitted} hint="At least 8 characters" />
          <Field label="Password" type="password" value={password} onChange={setPassword} rules={[required(), minLength(8)]} submitAttempted={submitted} />
          <Field label="Repeat password" type="password" value={repeat} onChange={setRepeat} rules={[required(), repeatOf(() => password)]} submitAttempted={submitted} />
          <div><Button variant="primary" onClick={() => setSubmitted(true)}>Submit</Button></div>
        </Section>
        <Section title="Dialogs (own, never the browser's)">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                void confirm({
                  title: "Skizze „Boden“ löschen?",
                  message: "Die Skizze und die zwei Körper, die darauf beruhen, werden gelöscht. Das lässt sich mit Rückgängig zurücknehmen.",
                  confirmLabel: "Löschen",
                  tone: "destructive",
                }).then((ok) => setAnswer(ok ? "confirmed" : "cancelled"))
              }
            >
              Destructive confirm
            </Button>
            <Button
              onClick={() =>
                void confirm({ title: "Not available yet", message: "This comes in a later version.", hideCancel: true, confirmLabel: "OK" }).then(() => setAnswer("info closed"))
              }
            >
              Info box
            </Button>
          </div>
          <div className="text-[13px] text-muted" data-testid="gallery-answer">{answer}</div>
        </Section>
        <Section title="Error notice">
          <ErrorNotice
            headline="Gehäuse.pcraft konnte nicht geöffnet werden: keine Partcraft-Datei, weil in der Datei die Datei manifest.json fehlt und der Inhalt sich nicht lesen lässt"
            code="PC-FILE-003"
            details={[
              { kind: "text", text: "In der Datei fehlt manifest.json. Partcraft erkennt Projekte an ihrem Inhalt, nicht an der Endung; diese Datei ist beschädigt oder ein anderes ZIP-Archiv mit der Endung .pcraft." },
              { kind: "code", text: "C:\\Users\\Name\\Documents\\Partcraft\\Gehäuse.pcraft" },
              { kind: "text", text: "Es wurde nichts verändert; geöffnete Projekte bleiben, wie sie waren." },
            ]}
            actions={<Button variant="primary">Open another file …</Button>}
          />
        </Section>
      </div>
    </div>
  );
}
