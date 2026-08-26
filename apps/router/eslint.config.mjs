import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@axel/credentials",
                "@axel/credentials/*",
                "../../packages/credentials",
                "../../packages/credentials/*",
                "../../../packages/credentials",
                "../../../packages/credentials/*"
              ],
              message: "Router must never import credential decrypt helpers.",
            },
          ],
        },
      ],
    },
  },
];
