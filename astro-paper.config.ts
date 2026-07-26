import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://blog.purgos.net/",
    title: "Purgos Blog",
    description: "Homelab builds, self-hosted services, and project writeups.",
    author: "Zachariah Moore",
    profile: "https://github.com/purgos",
    ogImage: "default-og.jpg",
    lang: "en",
    timezone: "Asia/Bangkok",
    dir: "ltr",
  },
  posts: {
    perPage: 4,
    perIndex: 4,
    scheduledPostMargin: 15 * 60 * 1000,
  },
  features: {
    lightAndDarkMode: true,
    dynamicOgImage: true,
    showArchives: true,
    showBackButton: true,
    editPost: {
      enabled: true,
      url: "https://github.com/purgos/astro-paper/edit/main/",
    },
    search: "pagefind",
  },
  socials: [
    { name: "matrix",    url: "https://matrix.to/#/@purgos:matrix.lilium-mg.net" },
    { name: "friendica", url: "https://friendica.lilium-mg.net/profile/purgos" },
  ],
  shareLinks: [
    { name: "whatsapp", url: "https://wa.me/?text=" },
    { name: "facebook", url: "https://www.facebook.com/sharer.php?u=" },
    { name: "x",        url: "https://x.com/intent/post?url=" },
    { name: "telegram", url: "https://t.me/share/url?url=" },
    { name: "pinterest", url: "https://pinterest.com/pin/create/button/?url=" },
    { name: "mail",     url: "mailto:?subject=See%20this%20post&body=" },
  ],
});