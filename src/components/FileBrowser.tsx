import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import jsonLang from "highlight.js/lib/languages/json";
import markdownLang from "highlight.js/lib/languages/markdown";
import {
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  Download,
  FlaskConical,
  Activity,
  Package,
  Play,
  Satellite,
  Send,
  Shield,
  Sliders,
  Terminal,
  WrapText,
  Zap,
} from "lucide-react";
import { Chip, Reveal, SectionHeading, cx } from "./ui";
import { FILES_META, type SourceFile } from "../lib/sources";

hljs.registerLanguage("python", python);
hljs.registerLanguage("json", jsonLang);
hljs.registerLanguage("markdown", markdownLang);

const ICONS: Record<string, typeof Copy> = {
  sliders: Sliders,
  play: Play,
  shield: Shield,
  brain: Brain,
  activity: Activity,
  satellite: Satellite,
  zap: Zap,
  flask: FlaskConical,
  send: Send,
  terminal: Terminal,
  database: Database,
  package: Package,
  book: BookOpen,
};

const GROUPS: { id: SourceFile["group"]; label: string; hint: string }[] = [
  { id: "runtime", label: "runtime", hint: "what you actually launch" },
  { id: "engine", label: "decision engine", hint: "signal → permission" },
  { id: "execution", label: "execution & data", hint: "the outside world" },
  { id: "research", label: "research", hint: "offline replay" },
  { id: "deploy", label: "deploy", hint: "watchdog, autostart, units" },
  { id: "project", label: "project", hint: "config, deps, docs, state" },
];

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function outlineOf(code: string) {
  const out: { line: number; kind: string; name: string }[] = [];
  code.split("\n").forEach((text, i) => {
    const m = /^(?:class|def)\s+([A-Za-z_][\w]*)/.exec(text);
    if (m) out.push({ line: i + 1, kind: text.trimStart().startsWith("class") ? "class" : "def", name: m[1] });
  });
  return out;
}

export function FileBrowser({ selected, onSelect }: { selected: string; onSelect: (name: string) => void }) {
  const file = useMemo(() => FILES_META.find((f) => f.name === selected) ?? FILES_META[0], [selected]);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idx = FILES_META.findIndex((f) => f.name === file.name);
  const lineCount = file.lines;
  const LINE_H = 20;

  const html = useMemo(() => {
    if (file.lang === "python" || file.lang === "json" || file.lang === "markdown") {
      try {
        return hljs.highlight(file.code, { language: file.lang, ignoreIllegals: true }).value;
      } catch {
        return escape(file.code);
      }
    }
    return escape(file.code);
  }, [file]);

  const outline = useMemo(() => (file.lang === "python" ? outlineOf(file.code) : []), [file]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [file.name]);

  const jump = (line: number) => {
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, (line - 3) * LINE_H);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([file.code], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const move = (delta: number) => onSelect(FILES_META[(idx + delta + FILES_META.length) % FILES_META.length].name);

  return (
    <section id="source" className="mx-auto max-w-[1400px] px-4 py-20 md:px-7">
      <Reveal>
        <SectionHeading
          index="06"
          kicker="complete source · one file at a time"
          tone="jade"
          title={
            <>
              Twelve files, <span className="tabnum">{FILES_META.reduce((s, f) => s + f.lines, 0).toLocaleString()}</span> lines,
              <br />
              <span className="text-muted">nothing elided.</span>
            </>
          }
          blurb={
            <>
              Every line below is the real file in <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[12.5px] text-amber">forex_bot/</code> — the same
              bytes that ship in the project, read straight from disk at build time. Start at{" "}
              <button onClick={() => onSelect("config.py")} className="font-mono text-[13px] text-jade underline decoration-dotted underline-offset-4 hover:text-sand">
                config.py
              </button>{" "}
              and walk outward.
            </>
          }
          right={
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => move(-1)}
                className="grid size-9 place-items-center rounded-lg border border-line bg-panel text-muted transition-colors hover:border-jade/40 hover:text-jade"
                aria-label="previous file"
              >
                <ChevronUp size={15} />
              </button>
              <span className="tabnum min-w-[74px] text-center font-mono text-[11px] text-muted">
                {idx + 1} / {FILES_META.length}
              </span>
              <button
                onClick={() => move(1)}
                className="grid size-9 place-items-center rounded-lg border border-line bg-panel text-muted transition-colors hover:border-jade/40 hover:text-jade"
                aria-label="next file"
              >
                <ChevronDown size={15} />
              </button>
            </div>
          }
        />
      </Reveal>

      <div className="grid gap-4 lg:grid-cols-[290px_minmax(0,1fr)]">
        {/* tree */}
        <Reveal>
          <div className="panel overflow-hidden rounded-xl">
            <div className="border-b border-line bg-panel-2/70 px-3.5 py-2.5 font-mono text-[10.5px] tracking-[0.2em] text-muted uppercase">
              forex_bot/
            </div>
            <div className="p-2">
              {GROUPS.map((g) => {
                const items = FILES_META.filter((f) => f.group === g.id);
                if (!items.length) return null;
                return (
                  <div key={g.id} className="mb-1.5">
                    <div className="px-2 py-1.5 font-mono text-[9.5px] tracking-[0.18em] text-line uppercase">
                      <span className="text-muted/70">{g.label}</span>
                      <span className="ml-1 text-muted/45">— {g.hint}</span>
                    </div>
                    <ul>
                      {items.map((f) => {
                        const Icon = ICONS[f.icon] ?? Terminal;
                        const active = f.name === file.name;
                        return (
                          <li key={f.name}>
                            <button
                              onClick={() => onSelect(f.name)}
                              className={cx(
                                "group flex w-full items-center gap-2 rounded-md px-2 py-[7px] text-left transition-colors",
                                active ? "bg-jade/12 text-sand ring-1 ring-jade/30 ring-inset" : "text-sand-2/80 hover:bg-panel-2",
                              )}
                            >
                              <Icon size={13} className={cx(active ? "text-jade" : "text-muted group-hover:text-sky")} />
                              <span className="font-mono text-[12px]">{f.name}</span>
                              <span className="tabnum ml-auto font-mono text-[9.5px] text-muted">{f.lines}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between border-t border-line px-3.5 py-2 font-mono text-[10px] text-muted">
              <span>requirements.txt · 3 deps</span>
              <span className="text-sky/70">mt5 bridge</span>
            </div>

            {outline.length > 0 && (
              <div className="max-h-[240px] overflow-y-auto border-t border-line p-2">
                <div className="px-2 py-1 font-mono text-[9.5px] tracking-[0.18em] text-muted uppercase">
                  outline · {outline.length} defs
                </div>
                {outline.map((o) => (
                  <button
                    key={`${o.line}`}
                    onClick={() => jump(o.line)}
                    className="flex w-full items-center gap-2 rounded px-2 py-[3px] text-left font-mono text-[10.5px] text-muted transition-colors hover:bg-panel-2 hover:text-sky"
                  >
                    <span className={cx("text-[9px]", o.kind === "class" ? "text-amber/70" : "text-lilac/70")}>{o.kind}</span>
                    <span className="truncate text-sand-2/80">{o.name}</span>
                    <span className="tabnum ml-auto text-line">{o.line}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Reveal>

        {/* code */}
        <Reveal delay={60} className="min-w-0">
          <div className="panel flex max-h-[82vh] min-w-0 flex-col overflow-hidden rounded-xl sm:max-h-[86vh]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel-2/60 px-4 py-3">
              <span className="font-mono text-[12.5px] font-medium text-sand">{file.path}</span>
              <Chip tone="line">{file.lang}</Chip>
              <span className="tabnum font-mono text-[10.5px] text-muted">
                {file.lines} lines · {(file.bytes / 1024).toFixed(1)} KB
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => setWrap((w) => !w)}
                  className={cx(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors",
                    wrap ? "border-sky/45 bg-sky/10 text-sky" : "border-line text-muted hover:text-sand-2",
                  )}
                >
                  <WrapText size={12} /> wrap
                </button>
                <button
                  onClick={copy}
                  className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors"
                  style={{ borderColor: copied ? "rgba(47,211,154,0.45)" : undefined }}
                >
                  {copied ? <Check size={12} className="text-jade" /> : <Copy size={12} className="text-muted" />}
                  <span className={copied ? "text-jade" : "text-muted"}>{copied ? "copied" : "copy"}</span>
                </button>
                <button
                  onClick={download}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[10.5px] text-muted transition-colors hover:text-sand-2"
                >
                  <Download size={12} /> save
                </button>
              </div>
            </div>

            <p className="border-b border-line-soft bg-ink-2/60 px-4 py-2.5 text-[13px] leading-snug text-sand-2/85">
              <span className="font-mono text-[11px] tracking-wider text-jade uppercase">role</span> — {file.role}
              <span className="mt-1 block text-[12.5px] text-muted">{file.note}</span>
            </p>

            <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto bg-ink-2/50">
              <div className="flex min-w-0">
                <div
                  aria-hidden
                  className="tabnum sticky left-0 z-10 shrink-0 select-none border-r border-line-soft bg-ink-2/95 px-2.5 text-right font-mono text-[11px] text-line"
                  style={{ lineHeight: `${LINE_H}px` }}
                >
                  {Array.from({ length: lineCount }, (_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </div>
                <pre
                  className={cx("hljs min-w-0 flex-1 px-4 font-mono text-[12.2px]", wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}
                  style={{ lineHeight: `${LINE_H}px`, margin: 0 }}
                >
                  <code dangerouslySetInnerHTML={{ __html: html }} />
                </pre>
              </div>
            </div>

            <div className="flex items-center gap-3 border-t border-line bg-panel-2/60 px-4 py-2 font-mono text-[10.5px] text-muted">
              <span className="text-jade">●</span> {file.name} is complete — {file.lines} lines rendered
              <button onClick={() => move(1)} className="ml-auto text-sky/80 transition-colors hover:text-sky">
                next file → {FILES_META[(idx + 1) % FILES_META.length].name}
              </button>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
