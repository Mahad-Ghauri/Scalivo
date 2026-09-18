/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // `@scalivo/shared` ships as workspace TypeScript compiled to ESM. Next has to
  // be told to transpile it rather than treat it as an opaque node_modules dep.
  transpilePackages: ['@scalivo/shared'],
};

export default nextConfig;
