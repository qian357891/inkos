export type CoverProviderId = "kkaiapi" | "openai" | "google" | "minimax";

export interface CoverProviderPreset {
  readonly service: CoverProviderId;
  readonly label: string;
  readonly baseUrl: string;
  readonly api: "responses" | "images" | "gemini" | "minimax-image";
  readonly defaultModel: string;
  readonly models: readonly string[];
  /** Optional mapping from inkos cover `size` (WIDTHxHEIGHT) to provider-specific ratio. */
  readonly supportedAspectRatios?: readonly string[];
}

export const COVER_PROVIDER_PRESETS: readonly CoverProviderPreset[] = [
  {
    service: "kkaiapi",
    label: "kkaiapi",
    baseUrl: "https://api.kkaiapi.com/v1",
    api: "images",
    defaultModel: "gpt-image-2",
    models: ["gpt-image-2"],
  },
  {
    service: "openai",
    label: "OpenAI Images",
    baseUrl: "https://api.openai.com/v1",
    api: "images",
    defaultModel: "gpt-image-2",
    models: ["gpt-image-2"],
  },
  {
    service: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "gemini",
    defaultModel: "gemini-3.1-flash-image-preview",
    models: ["gemini-3.1-flash-image-preview", "gemini-2.5-flash-image"],
  },
  {
    service: "minimax",
    label: "MiniMax Images",
    baseUrl: "https://api.minimaxi.com/v1",
    api: "minimax-image",
    defaultModel: "image-01",
    models: ["image-01"],
    // MiniMax's image_generation API uses fixed aspect ratios instead of pixel sizes.
    // Docs: https://platform.minimaxi.com/document/image
    supportedAspectRatios: ["16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"],
  },
];

export function resolveCoverProviderPreset(service: string | undefined): CoverProviderPreset | undefined {
  return COVER_PROVIDER_PRESETS.find((provider) => provider.service === service);
}

export function coverSecretKey(service: string): string {
  return `cover:${service}`;
}
