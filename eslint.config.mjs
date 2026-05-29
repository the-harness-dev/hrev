import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Model provider SDK restrictions — all model access must go through LangChain
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "openai",
              message: "Do not import the OpenAI SDK directly. Use @langchain/openai instead.",
            },
            {
              name: "@anthropic-ai/sdk",
              message: "Do not import Anthropic SDK directly. Use @langchain/openai with an OpenAI-compatible proxy.",
            },
            {
              name: "groq-sdk",
              message: "Do not import Groq SDK directly. Use @langchain/openai with an OpenAI-compatible endpoint.",
            },
            {
              name: "@google/generative-ai",
              message: "Do not import Google GenAI SDK directly. Use @langchain/openai with an OpenAI-compatible endpoint.",
            },
          ],
          patterns: [{
            group: ["@langchain/anthropic", "@langchain/groq", "@langchain/google-genai"],
            message: "Non-OpenAI-compatible LangChain provider SDKs are not allowed. Only @langchain/openai is permitted for model access.",
          }],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      // node:test handles promise lifecycles; callback-style tests look like floating promises
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  }
);
