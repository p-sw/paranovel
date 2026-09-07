/** Incrementally decodes only the root object's reply string, never its JSON envelope. */
export class JsonReplyStream {
  private depth = 0;
  private rootStarted = false;
  private expectingKey = false;
  private expectingValue = false;
  private key = '';
  private stringKind: 'key' | 'reply' | 'other' | undefined;
  private stringValue = '';
  private escaped = false;
  private unicode: string | undefined;
  private highSurrogate = '';
  private replyStarted = false;
  private invalid = false;
  private pending = '';
  text = '';

  constructor(private readonly onDelta: (text: string) => void) {}

  write(chunk: string): void {
    for (const character of chunk.split('')) {
      if (this.invalid) break;
      if (this.stringKind) {
        if (this.unicode !== undefined) {
          if (!/^[\da-f]$/i.test(character)) { this.invalid = true; break; }
          this.unicode += character;
          if (this.unicode.length === 4) {
            this.appendCharacter(String.fromCharCode(Number.parseInt(this.unicode, 16)));
            this.unicode = undefined;
          }
        } else if (this.escaped) {
          this.escaped = false;
          if (character === 'u') this.unicode = '';
          else {
            const escape: Record<string, string> = {
              '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
            };
            if (!(character in escape)) { this.invalid = true; break; }
            this.appendCharacter(escape[character]!);
          }
        } else if (character === '\\') this.escaped = true;
        else if (character === '"') {
          if (this.stringKind === 'key') this.key = this.stringValue;
          if (this.stringKind === 'reply' && this.highSurrogate) {
            this.pending += this.highSurrogate;
            this.highSurrogate = '';
          }
          this.stringKind = undefined;
        } else if (character.charCodeAt(0) < 0x20) this.invalid = true;
        else this.appendCharacter(character);
        continue;
      }

      if (/\s/.test(character)) continue;
      if (!this.rootStarted) {
        if (character !== '{') { this.invalid = true; break; }
        this.rootStarted = true;
        this.depth = 1;
        this.expectingKey = true;
        continue;
      }
      if (character === '"') {
        if (this.depth === 1 && this.expectingKey) {
          this.stringKind = 'key';
          this.expectingKey = false;
          this.stringValue = '';
        } else if (this.depth === 1 && this.expectingValue && this.key === 'reply' && !this.replyStarted) {
          this.stringKind = 'reply';
          this.replyStarted = true;
        } else this.stringKind = 'other';
        this.expectingValue = false;
      } else if (character === '{' || character === '[') {
        this.depth += 1;
        this.expectingValue = false;
      } else if (character === '}' || character === ']') this.depth -= 1;
      else if (this.depth === 1 && character === ':') this.expectingValue = true;
      else if (this.depth === 1 && character === ',') {
        this.expectingKey = true;
        this.expectingValue = false;
        this.key = '';
      } else this.expectingValue = false;
    }
    if (this.pending) {
      const delta = this.pending;
      this.pending = '';
      this.text += delta;
      this.onDelta(delta);
    }
  }

  private appendCharacter(character: string): void {
    if (this.stringKind === 'key') this.stringValue += character;
    if (this.stringKind !== 'reply') return;
    const code = character.charCodeAt(0);
    // Keep a pair together even when a JSON escape or UTF-16 pair crosses chunks.
    if (this.highSurrogate) {
      this.pending += this.highSurrogate;
      this.highSurrogate = '';
      if (code >= 0xdc00 && code <= 0xdfff) { this.pending += character; return; }
    }
    if (code >= 0xd800 && code <= 0xdbff) this.highSurrogate = character;
    else this.pending += character;
  }
}
