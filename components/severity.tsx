// How each severity looks. Colours come from BB theme tokens only, so the
// deck reads correctly in every palette.
import type { Severity, SlideKind } from "@/lib/deck-schema";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface SeverityStyle {
  label: string;
  /** The small chip. */
  chip: string;
  /** The left edge of the finding card and the highlighted code line. */
  accent: string;
  icon: IconName;
}

export const SEVERITY_STYLE: Record<Severity, SeverityStyle> = {
  blocker: {
    label: "Blocker",
    chip: "border-destructive bg-destructive text-destructive-foreground",
    accent: "border-l-destructive",
    icon: "AlertTriangle",
  },
  issue: {
    label: "Issue",
    chip: "border-destructive/40 bg-destructive/10 text-destructive",
    accent: "border-l-destructive/60",
    icon: "AlertCircle",
  },
  question: {
    label: "Question",
    chip: "border-primary/40 bg-primary/10 text-primary",
    accent: "border-l-primary/70",
    icon: "CircleQuestion",
  },
  nit: {
    label: "Nit",
    chip: "border-border bg-muted text-muted-foreground",
    accent: "border-l-border",
    icon: "Info",
  },
  info: {
    label: "Note",
    chip: "border-border bg-muted text-muted-foreground",
    accent: "border-l-border",
    icon: "Info",
  },
  praise: {
    label: "Nice",
    chip: "border-primary/30 bg-primary/5 text-primary",
    accent: "border-l-primary/40",
    icon: "CircleCheck",
  },
};

export function SeverityChip({
  severity,
  className,
}: {
  severity: Severity;
  className?: string;
}) {
  const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.info;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
        style.chip,
        className,
      )}
    >
      <Icon name={style.icon} className="size-3" />
      {style.label}
    </span>
  );
}

export const SLIDE_KIND_LABEL: Record<SlideKind, string> = {
  overview: "Overview",
  change: "Change",
  risk: "Risk",
  test: "Tests",
  wrapup: "Wrap up",
};

export function SlideKindChip({ kind }: { kind: SlideKind }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium uppercase leading-none tracking-wide text-muted-foreground">
      {SLIDE_KIND_LABEL[kind] ?? kind}
    </span>
  );
}
