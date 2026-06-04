#!/usr/bin/env node

import { spawn } from "node:child_process";

const zipFile = process.argv[2];

if (!zipFile) {
  console.error("Usage: node zipinfo-modified.mjs <zip-file>");
  process.exit(1);
}

const zipinfo = spawn("zipinfo", ["-v", zipFile], {
  stdio: ["ignore", "pipe", "inherit"],
});

let currentFile = null;
let wantFile = false;
let buffer = "";

function handleLine(line) {
  if (line.startsWith("Central directory entry")) {
    wantFile = true;
    return;
  }

  if (wantFile) {
    const trimmed = line.trim();

    if (trimmed === "" || /^-+$/.test(trimmed)) {
      return;
    }

    currentFile = trimmed;
    wantFile = false;
    return;
  }

  if (line.includes("file last modified on")) {
    console.log(currentFile ?? "(unknown filename)");
    console.log(line);
  }
}

zipinfo.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");

  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    handleLine(line);
  }
});

zipinfo.stdout.on("end", () => {
  if (buffer.length > 0) {
    handleLine(buffer);
  }
});

zipinfo.on("error", (err) => {
  console.error(`Failed to run zipinfo: ${err.message}`);
  process.exit(1);
});

zipinfo.on("close", (code) => {
  process.exit(code ?? 0);
});
