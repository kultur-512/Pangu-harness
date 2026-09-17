#!/usr/bin/env node
// scripts/eval/longmemeval-48/run-serial.mjs
// Serial runner: executes cells one at a time, resume-friendly,
// and kicks off the next cell as soon as one finishes.
// Order: 1B cells first (CC×M3 already done, skip A1/B1), then M3 cells.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CELL_MJS = resolve('P:/MY_codes/Pangu/scripts/eval/longmemeval-48/cell.mjs');
const OUT_DIR = 'P:/MY_codes/Pangu/scripts/eval/longmemeval-48';

// Order: 1B cells first, then M3 cells
// A1=CC×M3 recall, B1=CC×M3 pipeline — already done, skip
const queue = [
  // 1B rep1 (resume partial progress)
  'C1', 'E1', 'F1', 'H1', 'I1',
  // 1B rep2 (fresh)
  'C2', 'E2', 'F2', 'H2', 'I2',
  // 1B rep3 (fresh)
  'C3', 'E3', 'F3', 'H3', 'I3',
  // M3 cells
  'D1',  // Pi×M3
  'G1',  // ZL-direct×M3
];

let idx = 0;
const startTime = Date.now();

function log(msg) {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`[${elapsed}s] ${msg}`);
}

function runCell(cellId) {
  return new Promise((resolve) => {
    log(`Starting cell ${cellId}`);
    const child = spawn('node', [CELL_MJS, '--cell', cellId], {
      stdio: 'inherit',
      cwd: 'P:/MY_codes/Pangu',
      windowsHide: true,
      shell: true,
    });
    child.on('close', (code) => {
      log(`Cell ${cellId} exited code ${code}`);
      resolve(code);
    });
  });
}

async function main() {
  // Load progress
  let lastDone = -1;
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i];
    const outFile = `${OUT_DIR}/answers-${cell}.jsonl`;
    if (existsSync(outFile)) {
      const lines = readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length >= 48) {
        lastDone = i;
        log(`Cell ${cell} already complete (48/48)`);
      }
    }
  }

  const startIdx = lastDone + 1;
  log(`Starting from index ${startIdx} (${queue[startIdx]}) of ${queue.length} cells`);

  for (let i = startIdx; i < queue.length; i++) {
    const cell = queue[i];
    const code = await runCell(cell);
    if (code !== 0) {
      log(`WARNING: cell ${cell} exited non-zero ${code} — continuing anyway`);
    }
  }
  log('ALL DONE');
}

main().catch(console.error);
