export function parseSExpr(text: string): any[] {
  const result: any[] = []
  let i = 0
  const len = text.length

  function skipWhitespace() {
    while (i < len && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++
  }

  function parseAtom(): string {
    let start = i
    if (text[i] === '"') {
      i++
      start = i
      while (i < len && text[i] !== '"') {
        if (text[i] === "\\") i++
        i++
      }
      const s = text.substring(start, i)
      if (i < len) i++
      return s
    }
    while (i < len && text[i] !== "(" && text[i] !== ")" && text[i] !== " " && text[i] !== "\t" && text[i] !== "\n" && text[i] !== "\r") i++
    return text.substring(start, i)
  }

  function parseList(): any[] {
    i++
    const items: any[] = []
    skipWhitespace()
    while (i < len && text[i] !== ")") {
      if (text[i] === "(") items.push(parseList())
      else items.push(parseAtom())
      skipWhitespace()
    }
    if (i < len) i++
    return items
  }

  skipWhitespace()
  while (i < len) {
    if (text[i] === "(") result.push(parseList())
    else if (text[i] !== " " && text[i] !== "\t" && text[i] !== "\n" && text[i] !== "\r") result.push(parseAtom())
    else i++
  }
  return result
}
