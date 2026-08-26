"use client";

import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";

export function ApiReference() {
  return (
    <ApiReferenceReact
      configuration={{
        url: "/openapi.yaml",
        theme: "default",
        layout: "classic",
        hideDownloadButton: false,
        defaultOpenAllTags: true,
        defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
        metaData: {
          title: "Axel API reference",
        },
      }}
    />
  );
}
