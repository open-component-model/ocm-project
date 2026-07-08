import js from "@eslint/js";
import n from "eslint-plugin-n";
import globals from "globals";

export default [
  js.configs.recommended,
  n.configs["flat/recommended-module"],
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Internal, unpublished scripts folder: importing devDependencies (eslint,
      // test tooling) from config/tests does not ship to any consumer.
      "n/no-unpublished-import": "off",
      // Enforce the modern Node practices used in these scripts.
      "n/prefer-node-protocol": "error",
      "n/prefer-global/process": "error",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    // CLI entry point: exiting the process on bad input / missing env is intended.
    files: ["**/*.local.js"],
    rules: { "n/no-process-exit": "off" },
  },
];
