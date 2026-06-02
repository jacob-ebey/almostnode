import { cp, readFile, stat } from "node:fs/promises";

import { build } from "esbuild";
import { nodeModulesPolyfillPlugin } from "esbuild-plugins-node-modules-polyfill";

await build({
  entryPoints: ["./dist/index.mjs"],
  bundle: true,
  format: "esm",
  outfile: "./dist/bundle.js",
  plugins: [
    {
      name: "fix-almostnode",
      setup(build) {
        build.onLoad({ filter: /.*/ }, async (args) => {
          if (
            await stat(args.path)
              .then((s) => s.isFile())
              .catch(() => false)
          ) {
            let contents = await readFile(args.path, "utf-8");
            if (args.path.endsWith("just-bash/dist/bundle/browser.js")) {
              contents = contents.replace("import{constants as Yo,", "import{");
              return {
                contents,
              };
            }
          }
        });
      },
    },
    nodeModulesPolyfillPlugin(),
  ],
});
