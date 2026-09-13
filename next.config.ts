import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev badge sits on top of the timeline scrubber in the bottom left.
  devIndicators: false,
  // Without this, a stray lockfile further up the drive is treated as the
  // workspace root.
  turbopack: { root: __dirname },
};

export default nextConfig;
