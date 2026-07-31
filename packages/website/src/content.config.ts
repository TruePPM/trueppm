import { defineCollection, z } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        /**
         * The newest TruePPM version whose behavior this page documents.
         *
         * Declared so `scripts/check-version-status.sh` can pair it against the
         * roadmap: when this names a version that is still Underway or Planned,
         * the page MUST carry a "Ships in 0.X" callout, and when it names a
         * shipped version the page must NOT. The gate's original regex could
         * only catch a claim that anchored itself to a version ("shipped in
         * 0.4"); it was structurally blind to a page describing an unreleased
         * feature in plain present tense, which is how four pages told a 0.3
         * self-hoster to use features that did not exist in their install
         * (#2608). Declaring the version once is what makes the pairing
         * checkable at all.
         *
         * Optional: a page documenting only long-shipped behavior needs no key.
         */
        documentedFor: z.string().optional(),
      }),
    }),
  }),
};
