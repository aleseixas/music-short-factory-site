import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ROUTES = new Set(["/auth/tiktok"]);

function attributes(source, name) {
  const expression = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "gi");
  return [...source.matchAll(expression)].map((match) => match[1]);
}

function ids(source) {
  return attributes(source, "id");
}

test("all public HTML pages have unique IDs and valid local links", async () => {
  const htmlFiles = (await readdir(ROOT)).filter((name) => name.endsWith(".html"));
  const sources = new Map(
    await Promise.all(
      htmlFiles.map(async (name) => [name, await readFile(join(ROOT, name), "utf8")]),
    ),
  );

  for (const [filename, source] of sources) {
    assert.match(source, /<!DOCTYPE html>/i, `${filename}: missing HTML5 doctype`);
    assert.match(source, /<html\s+lang="en">/i, `${filename}: missing English language`);
    assert.match(source, /<meta\s+name="viewport"/i, `${filename}: missing viewport`);
    assert.match(source, /<meta\s+name="description"/i, `${filename}: missing description`);
    assert.match(source, /<title>[^<]+<\/title>/i, `${filename}: missing title`);
    assert.match(source, /<main\b/i, `${filename}: missing main landmark`);
    assert.match(source, /<h1\b/i, `${filename}: missing h1`);

    const pageIds = ids(source);
    assert.equal(
      new Set(pageIds).size,
      pageIds.length,
      `${filename}: duplicate id`,
    );

    for (const href of attributes(source, "href")) {
      if (/^(?:https?:|mailto:|tel:)/i.test(href)) continue;
      if (SERVER_ROUTES.has(href)) continue;
      const [rawPath, fragment] = href.split("#", 2);
      const targetName = rawPath || filename;
      const normalizedName = targetName.startsWith("/")
        ? targetName.slice(1)
        : targetName;
      const targetPath = resolve(ROOT, normalizedName);
      assert.equal(
        targetPath.startsWith(ROOT),
        true,
        `${filename}: link escapes public root (${href})`,
      );
      const targetSource = sources.get(normalizedName);
      if (normalizedName.endsWith(".html") || !rawPath) {
        assert.ok(targetSource, `${filename}: missing local page (${href})`);
        if (fragment) {
          assert.ok(
            new Set(ids(targetSource)).has(decodeURIComponent(fragment)),
            `${filename}: missing fragment (${href})`,
          );
        }
      } else {
        await assert.doesNotReject(
          readFile(targetPath),
          `${filename}: missing local resource (${href})`,
        );
      }
    }

    for (const src of attributes(source, "src")) {
      if (/^(?:https?:|data:)/i.test(src)) continue;
      const targetPath = resolve(ROOT, src.split(/[?#]/, 1)[0]);
      assert.equal(
        targetPath.startsWith(ROOT),
        true,
        `${filename}: asset escapes public root (${src})`,
      );
      await assert.doesNotReject(
        readFile(targetPath),
        `${filename}: missing local asset (${src})`,
      );
    }
  }
});

test("homepage exposes legal policies and sitemap contains every review page", async () => {
  const home = await readFile(join(ROOT, "index.html"), "utf8");
  assert.match(home, /class="legal-direct"[\s\S]*href="terms\.html"/i);
  assert.match(home, /class="legal-direct"[\s\S]*href="privacy\.html"/i);

  const sitemap = await readFile(join(ROOT, "sitemap.xml"), "utf8");
  for (const page of [
    "about.html",
    "app.html",
    "support.html",
    "privacy.html",
    "terms.html",
    "data-deletion.html",
  ]) {
    assert.match(sitemap, new RegExp(`/${page.replace(".", "\\.")}<\\/loc>`));
  }
});
