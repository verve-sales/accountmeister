import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "unpdf", "mammoth", "exceljs"],
  // e65: Adressen passend zu den Menünamen (die bisherigen Adressen bleiben gültig)
  async rewrites() {
    return [
      { source: "/sales-ops", destination: "/vertragsbuero" },
      { source: "/kundenverantwortliche", destination: "/meine-principals" },
      { source: "/kundenverantwortliche/:id", destination: "/meine-principals/:id" },
    ];
  },
  experimental: {
    // Dokumentenupload über Server-Aktionen: Grenze über MAX_UPLOAD_MB (Standard 25) plus Multipart-Zuschlag
    serverActions: { bodySizeLimit: `${Number(process.env.MAX_UPLOAD_MB ?? 25) + 1}mb` },
  },
};

export default nextConfig;
