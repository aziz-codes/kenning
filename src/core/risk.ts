import type { Hunk, Risk, Severity } from "./types";

interface Rule {
  id: string;
  severity: Severity;
  title: string | ((m: RegExpMatchArray) => string);
  /** Pattern tested on added lines. */
  added?: RegExp;
  /** Pattern tested on removed lines (and only fires if not re-added). */
  removed?: RegExp;
  /** Restricts the rule to matching file paths. */
  path?: RegExp;
  /** Excludes matching file paths. */
  notPath?: RegExp;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$/i;

const RULES: Rule[] = [
  // ── High: things that silently weaken safety or verification ─────────────
  {
    id: "secret",
    severity: "high",
    title: "Possible secret in code",
    added:
      /(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\s]{8,}["'])/i,
    notPath: DOC_FILE,
  },
  {
    id: "test-removed",
    severity: "high",
    title: "Test removed",
    removed: /\b(?:it|test|describe)\s*\(\s*["'`]|^\s*def\s+test_|@Test\b|func\s+Test[A-Z]|#\[test\]/,
  },
  {
    id: "test-skipped",
    severity: "high",
    title: "Test skipped or focused",
    added: /\b(?:it|test|describe)\.(?:skip|only|todo)\s*\(|\bx(?:it|describe)\s*\(|@pytest\.mark\.skip|@unittest\.skip|@Disabled\b|@Ignore\b|\bt\.Skip\(|#\[ignore\]/,
  },
  {
    id: "assertion-weakened",
    severity: "high",
    title: "Assertion removed",
    removed: /\b(?:expect|assert(?:Equal|True|False|That)?)\s*[(.]|\bassert\s+\S/,
    path: TEST_FILE,
  },
  {
    id: "tls-off",
    severity: "high",
    title: "TLS verification turned off",
    added: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:0|false)/,
  },
  // ── Medium: worth a careful look ──────────────────────────────────────────
  {
    id: "error-handling-removed",
    severity: "medium",
    title: "Error handling removed",
    removed: /\b(?:try|catch|except|finally|rescue|throw|raise)\b|\.catch\(|if\s*\(?\s*err(?:or)?\s*(?:!=|\)|$)|if err != nil/,
    notPath: DOC_FILE,
  },
  {
    id: "guard-removed",
    severity: "medium",
    title: "A check was removed",
    removed: /^\s*(?:if|guard|unless)\b.*(?:null|undefined|None|nil|\.length|\bisEmpty|\b0\b|!\s*\w|===?|!==?|<=?|>=?|\bnot\b)/,
    notPath: DOC_FILE,
  },
  {
    id: "suppression",
    severity: "medium",
    title: "Type or lint check silenced",
    added: /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|#\s*type:\s*ignore|#\s*noqa|#\[allow\(|@SuppressWarnings|\bas any\b|:\s*any\b(?!\w)|\/\/\s*nolint/,
  },
  {
    id: "dangerous-call",
    severity: "medium",
    title: "Runs code or shell commands",
    added: /\beval\s*\(|new Function\s*\(|\bexec(?:Sync)?\s*\(|child_process|shell\s*=\s*True|os\.system\s*\(|subprocess\.\w+\(|Runtime\.getRuntime\(\)\.exec|dangerouslySetInnerHTML|\.innerHTML\s*=/,
  },
  {
    id: "sql-concat",
    severity: "medium",
    title: "SQL built from strings",
    added: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(?:["'`]\s*\+|\$\{|%s|\{\w*\})|f["'](?:SELECT|INSERT|UPDATE|DELETE)\b/i,
  },
  {
    id: "dependency",
    severity: "medium",
    title: (m) => `New dependency: ${m[1]}`,
    added: /^\s*"(@?[\w.-]+(?:\/[\w.-]+)?)"\s*:\s*"[\^~>=<]?\s*\d/,
    path: /(^|\/)package\.json$/,
  },
  {
    id: "dependency",
    severity: "medium",
    title: (m) => `New dependency: ${m[1]}`,
    added: /^\s*([A-Za-z][\w.-]*)\s*(?:[=<>~!]=|>|<)/,
    path: /(^|\/)requirements[^/]*\.txt$/,
  },
  {
    id: "dependency",
    severity: "medium",
    title: "Dependencies changed",
    added: /\S/,
    path: /(^|\/)(?:go\.mod|Cargo\.toml|Gemfile|composer\.json|pyproject\.toml|Pipfile|build\.gradle(?:\.kts)?|pom\.xml)$/,
  },
  {
    id: "auth",
    severity: "medium",
    title: "Touches authentication or permissions",
    added: /\b(?:authenticat\w*|authoriz\w*|password\w*|permissions?|isAdmin|jwt|csrf|cors|oauth\w*|bcrypt|hashPassword)\b/i,
    notPath: DOC_FILE,
  },
  {
    id: "infra",
    severity: "medium",
    title: "Infrastructure or config file changed",
    added: /\S/,
    path: /(^|\/)(?:\.env[^/]*|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.github\/workflows\/[^/]+|\.gitlab-ci\.yml|[^/]+\.tf|(?:k8s|helm|charts)\/.+|migrations?\/.+)$/,
  },
  // ── Low: tidy-up hints ────────────────────────────────────────────────────
  {
    id: "debug",
    severity: "low",
    title: "Debug output left in",
    added: /\bconsole\.(?:log|debug|trace)\s*\(|\bdebugger\s*;|\bvar_dump\s*\(|\bdbg!\(|\bfmt\.Print(?:ln|f)?\s*\(|\bSystem\.out\.print/,
    notPath: /(^|\/)(?:scripts?|bin|cli)\/|\.md$/,
  },
  {
    id: "todo",
    severity: "low",
    title: "TODO left behind",
    added: /\b(?:TODO|FIXME|HACK|XXX)\b/,
  },
  {
    id: "localhost",
    severity: "low",
    title: "Hard-coded local URL",
    added: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/,
    notPath: /(^|\/)(?:\.env[^/]*|docker-compose[^/]*|README[^/]*)$|\.md$/,
  },
  {
    id: "sleep",
    severity: "low",
    title: "Added a fixed wait",
    added: /\b(?:time\.)?sleep\s*\(|Thread\.sleep\s*\(|setTimeout\s*\([^,]+,\s*\d{4,}\s*\)/,
  },
  {
    id: "large-deletion",
    severity: "medium",
    title: "Large deletion",
  },
];

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
export const severityRank = (s: Severity) => RANK[s];

/** Flags risky patterns in a change, most severe first. One flag per rule. */
export function detectRisks(h: Hunk): Risk[] {
  const added = h.lines.filter((l) => l.kind === "add").map((l) => l.text);
  const removed = h.lines.filter((l) => l.kind === "del").map((l) => l.text);
  const addedSet = new Set(added.map((l) => l.trim()));
  const found = new Map<string, Risk>();

  for (const rule of RULES) {
    if (found.has(rule.id)) continue;
    if (rule.path && !rule.path.test(h.file)) continue;
    if (rule.notPath?.test(h.file)) continue;

    if (rule.id === "large-deletion") {
      if (h.kind !== "deleted" && removed.length >= 40 && removed.length > added.length * 2) {
        found.set(rule.id, { id: rule.id, severity: rule.severity, title: `Large deletion (${removed.length} lines)` });
      }
      continue;
    }

    let match: RegExpMatchArray | null = null;
    let line = "";
    if (rule.added) {
      for (const l of added) {
        const m = l.match(rule.added);
        if (m) {
          match = m;
          line = l;
          break;
        }
      }
    }
    if (!match && rule.removed) {
      for (const l of removed) {
        if (addedSet.has(l.trim())) continue; // moved, not removed
        const m = l.match(rule.removed);
        if (m) {
          match = m;
          line = l;
          break;
        }
      }
    }
    if (!match) continue;
    const title = typeof rule.title === "function" ? rule.title(match) : rule.title;
    found.set(rule.id, { id: rule.id, severity: rule.severity, title, detail: line.trim().slice(0, 140) });
  }

  // A deleted file is its own story; don't pile on removal warnings.
  if (h.kind === "deleted") {
    for (const id of ["error-handling-removed", "guard-removed", "assertion-weakened"]) found.delete(id);
  }

  return [...found.values()].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}
