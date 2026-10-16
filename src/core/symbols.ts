// Finds the function, method or class a changed line belongs to, across the
// common languages, by scanning upwards for a declaration.

const PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, // JS/TS function
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, // arrow fn
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, // class
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, // Python def
  /^\s*class\s+([A-Za-z_]\w*)/, // Python/Ruby class
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, // Go
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, // Rust
  /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, // Ruby
  /^\s*(?:public|private|protected|internal|static|final|override|virtual|async|\s)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\([^;]*$/, // Java/C#/Kotlin method
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, // TS/JS class method
];

const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try"]);

export function enclosingSymbol(lines: string[], lineIndex: number, maxScan = 300): string | undefined {
  const start = Math.min(lineIndex, lines.length - 1);
  for (let i = start; i >= 0 && start - i <= maxScan; i--) {
    const line = lines[i];
    for (const re of PATTERNS) {
      const m = re.exec(line);
      if (m?.[1] && !NOT_NAMES.has(m[1])) return m[1];
    }
  }
  return undefined;
}
