// src/cli/repl/MultilineBuffer.ts
// Simple multiline input buffer for ZIS

export class MultilineBuffer {
  private lines: string[] = [];
  private active = false;

  start(): void {
    this.lines = [];
    this.active = true;
  }

  addLine(line: string): void {
    if (this.active) {
      this.lines.push(line);
    }
  }

  submit(): string {
    const result = this.lines.join('\n');
    this.reset();
    return result;
  }

  cancel(): void {
    this.reset();
  }

  isActive(): boolean {
    return this.active;
  }

  private reset(): void {
    this.lines = [];
    this.active = false;
  }

  getCurrent(): string {
    return this.lines.join('\n');
  }
}
