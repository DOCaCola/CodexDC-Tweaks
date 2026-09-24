import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const testDir = dirname(fileURLToPath(import.meta.url));
const tweak = require(join(
  testDir,
  "..",
  "tweaks",
  "image-file-enhancements",
  "index.js",
)) as {
  __test: {
    decodeLocalImageSource(source: unknown, platform: string): string | null;
    versionImageUrl(source: string, version: string): string | null;
    versionLocalImagePath(path: string, version: string, platform: string): string | null;
    findPathInFiber(fiber: unknown, platform: string): string | null;
    resolveImagePath(image: unknown, api: unknown, platform: string): string | null;
    inspectImage(image: unknown, api: unknown, platform: string): string | null;
    collectMutationImages(records: unknown[]): Set<unknown>;

    refreshImageElement(
      image: unknown,
      path: string,
      version: string,
      platform?: string,
    ): void;
  };
};

test("image enhancement helpers resolve and version local image sources", () => {
  assert.equal(
    tweak.__test.decodeLocalImageSource("app://fs/@fs/C:/tmp/My%20Image.png", "win32"),
    "C:\\tmp\\My Image.png",
  );
  assert.equal(
    tweak.__test.versionImageUrl(
      "app://fs/@fs/C:/tmp/image.png?existing=1&codexpp_file_version=old",
      "123-456",
    ),
    "app://fs/@fs/C:/tmp/image.png?existing=1&codexpp_file_version=123-456",
  );
  assert.equal(
    tweak.__test.versionLocalImagePath(
      "C:\\tmp\\My Image #1?.png",
      "123-456",
      "win32",
    ),
    "app://fs/@fs/C:/tmp/My%20Image%20%231%3F.png?codexpp_file_version=123-456",
  );
});

test("image enhancement helpers find source paths in owner fibers", () => {
  const fiber = {
    memoizedProps: {},
    return: {
      memoizedProps: {
        attachment: { fullSrc: "app://fs/@fs/C:/tmp/image.png" },
      },
      return: null,
    },
  };
  assert.equal(tweak.__test.findPathInFiber(fiber, "win32"), "C:\\tmp\\image.png");
});

test("image enhancement resolves persisted snapshots through their owner fiber", () => {
  const image = createImage(new Map([
    ["src", "data:image/png;base64,AAAA"],
  ]));
  const api = {
    react: {
      getFiber() {
        return {
          memoizedProps: {
            item: {
              path: "C:\\tmp\\image.png",
            },
          },
          return: null,
        };
      },
    },
  };

  assert.equal(
    tweak.__test.resolveImagePath(image, api, "win32"),
    "C:\\tmp\\image.png",
  );
});


test("image enhancement inspects each candidate through React at most once", () => {
  const image = {
    ...createImage(new Map([["src", "data:image/png;base64,AAAA"]])),
    tagName: "IMG",
    matches() {
      return false;
    },
    closest() {
      return {};
    },
  };
  let fiberReads = 0;
  const api = {
    react: {
      getFiber() {
        fiberReads += 1;
        return {
          memoizedProps: {
            attachment: { path: "C:\\tmp\\image.png" },
          },
          return: null,
        };
      },
    },
  };

  assert.equal(
    tweak.__test.inspectImage(image, api, "win32"),
    "C:\\tmp\\image.png",
  );
  assert.equal(fiberReads, 1);
});

test("image enhancement mutation collection ignores its own source writes", () => {
  const attributes = new Map<string, string>([
    ["src", "app://fs/@fs/C:/tmp/image.png"],
  ]);
  const image = {
    ...createImage(attributes),
    tagName: "IMG",
  };

  tweak.__test.refreshImageElement(image, "C:\\tmp\\image.png", "123-456", "win32");
  assert.equal(
    tweak.__test.collectMutationImages([{ type: "attributes", target: image }]).size,
    0,
  );

  attributes.set("src", "app://fs/@fs/C:/tmp/replacement.png");
  assert.deepEqual(
    [...tweak.__test.collectMutationImages([{ type: "attributes", target: image }])],
    [image],
  );
});

test("image enhancement mutation collection only scans relevant subtrees", () => {
  const nestedImage = { tagName: "IMG" };
  let subtreeScans = 0;
  const addedContainer = {
    nodeType: 1,
    tagName: "DIV",
    childElementCount: 1,
    querySelectorAll(selector: string) {
      subtreeScans += 1;
      assert.equal(selector, "img");
      return [nestedImage];
    },
  };

  assert.deepEqual(
    [...tweak.__test.collectMutationImages([{
      type: "childList",
      addedNodes: [addedContainer],
      removedNodes: [],
    }])],
    [nestedImage],
  );
  assert.equal(subtreeScans, 1);

  const removedImage = { nodeType: 1, tagName: "IMG" };
  assert.deepEqual(
    [...tweak.__test.collectMutationImages([{
      type: "childList",
      addedNodes: [],
      removedNodes: [removedImage],
    }])],
    [removedImage],
  );

  let leafScans = 0;
  tweak.__test.collectMutationImages([{
    type: "childList",
    addedNodes: [{
      nodeType: 1,
      tagName: "SPAN",
      childElementCount: 0,
      querySelectorAll() {
        leafScans += 1;
        return [];
      },
    }],
  }]);
  assert.equal(leafScans, 0);
});

test("image enhancement resets cached source when React reuses an image element", () => {
  const attributes = new Map<string, string>([
    ["src", "app://fs/@fs/C:/tmp/new.png"],
    ["data-codexpp-original-src", "app://fs/@fs/C:/tmp/old.png"],
    ["data-codexpp-local-image-path", "C:\\tmp\\old.png"],
    ["data-codexpp-file-version", "1-10"],
  ]);
  const image = createImage(attributes);

  tweak.__test.refreshImageElement(image, "C:\\tmp\\new.png", "2-20", "win32");

  assert.equal(attributes.has("data-codexpp-original-src"), false);
  assert.equal(
    attributes.get("src"),
    "app://fs/@fs/C:/tmp/new.png?codexpp_file_version=2-20",
  );
});

test("image enhancement replaces persisted data URLs with live local files", () => {
  const attributes = new Map<string, string>([
    ["src", "data:image/png;base64,AAAA"],
  ]);
  const image = createImage(attributes);

  tweak.__test.refreshImageElement(image, "C:\\tmp\\image.png", "123-456", "win32");

  assert.equal(
    attributes.get("src"),
    "app://fs/@fs/C:/tmp/image.png?codexpp_file_version=123-456",
  );
  assert.equal(attributes.has("data-codexpp-original-src"), false);

  tweak.__test.refreshImageElement(image, "C:\\tmp\\image.png", "124-456", "win32");
  assert.equal(
    attributes.get("src"),
    "app://fs/@fs/C:/tmp/image.png?codexpp_file_version=124-456",
  );
});

function createImage(attributes: Map<string, string>) {
  return {
    src: attributes.get("src"),
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
  };
}
