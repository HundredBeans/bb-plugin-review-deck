// A prompt box that completes skill names the way the chat composer does.
//
// The SDK has no reusable prompt editor — `experimental_NewThreadComposer`
// creates a thread, and `useComposer` drives the chat box — so this is a
// textarea with its own `/` menu over the real skill catalogue.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/server";
import { cn } from "@/lib/utils";

export interface SkillOption {
  name: string;
  description: string;
  scope: string;
}

/** One shared fetch per page — the catalogue does not change while you type. */
export function useSkills(projectId?: string | null): SkillOption[] {
  const rpc = useRpc<typeof rpcContract>();
  const [skills, setSkills] = useState<SkillOption[]>([]);
  useEffect(() => {
    let live = true;
    rpc.call("skills_list", { projectId: projectId ?? null }).then(
      (result) => {
        if (live) setSkills(result.skills);
      },
      () => {
        if (live) setSkills([]);
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, projectId]);
  return skills;
}

/**
 * The `/word` being typed at the caret, or null.
 *
 * A slash only opens the menu at the start of the text or after whitespace, so
 * a path like `src/config.ts` does not trigger it.
 */
export function slashTokenAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  let index = caret - 1;
  while (index >= 0) {
    const char = text[index] as string;
    if (char === "/") break;
    if (/\s/.test(char)) return null;
    index -= 1;
  }
  if (index < 0) return null;
  const before = index === 0 ? "" : (text[index - 1] as string);
  if (before !== "" && !/\s/.test(before)) return null;
  return { start: index, query: text.slice(index + 1, caret) };
}

/** Skills whose name or description matches, best first. */
export function matchSkills(
  skills: SkillOption[],
  query: string,
  limit = 8,
): SkillOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return skills.slice(0, limit);
  const starts: SkillOption[] = [];
  const contains: SkillOption[] = [];
  const described: SkillOption[] = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(skill);
    else if (name.includes(needle)) contains.push(skill);
    else if (skill.description.toLowerCase().includes(needle)) {
      described.push(skill);
    }
  }
  return [...starts, ...contains, ...described].slice(0, limit);
}

export function PromptField({
  value,
  onChange,
  placeholder,
  rows = 3,
  projectId,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  projectId?: string | null;
  className?: string;
  ariaLabel?: string;
}) {
  const skills = useSkills(projectId);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [token, setToken] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [active, setActive] = useState(0);

  const matches = useMemo(
    () => (token === null ? [] : matchSkills(skills, token.query)),
    [skills, token],
  );
  const open = token !== null && matches.length > 0;

  const sync = useCallback((element: HTMLTextAreaElement) => {
    setToken(slashTokenAt(element.value, element.selectionStart ?? 0));
    setActive(0);
  }, []);

  const accept = (skill: SkillOption) => {
    const element = inputRef.current;
    if (element === null || token === null) return;
    const caret = element.selectionStart ?? value.length;
    const next = `${value.slice(0, token.start)}/${skill.name} ${value.slice(caret)}`;
    const position = token.start + skill.name.length + 2;
    onChange(next);
    setToken(null);
    // Put the caret after the inserted name once React has written the value.
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(position, position);
    });
  };

  return (
    <div className={cn("relative", className)}>
      <textarea
        ref={inputRef}
        value={value}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? "review-deck-skill-menu" : undefined}
        aria-autocomplete="list"
        onChange={(event) => {
          onChange(event.target.value);
          sync(event.target);
        }}
        onClick={(event) => sync(event.currentTarget)}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            sync(event.currentTarget);
          }
        }}
        onBlur={() => setToken(null)}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((current) => (current + 1) % matches.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive(
              (current) => (current - 1 + matches.length) % matches.length,
            );
          } else if (event.key === "Enter" || event.key === "Tab") {
            // Enter picks the highlighted skill instead of adding a newline.
            event.preventDefault();
            const picked = matches[active];
            if (picked !== undefined) accept(picked);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setToken(null);
          }
        }}
        className="w-full resize-y rounded border border-border bg-background px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />

      {open ? (
        <ul
          id="review-deck-skill-menu"
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 list-none overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-lg"
        >
          {matches.map((skill, index) => (
            <li key={skill.name} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                // The textarea blurs before click lands, so act on mousedown.
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(skill);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "block w-full border-0 bg-transparent px-3 py-1.5 text-left",
                  index === active ? "bg-accent" : "",
                )}
              >
                <span className="font-mono text-[12px] text-foreground">
                  /{skill.name}
                </span>
                {skill.description === "" ? null : (
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {skill.description}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {open ? null : (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Type <code>/</code> to use a skill.
        </p>
      )}
    </div>
  );
}
