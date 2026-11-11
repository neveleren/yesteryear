# Chrome Web Store listing (copy-paste source)

Package: `yesteryear-<version>-chrome-web-store.zip` (the contents of `extension/`, manifest at the root).

## Store listing tab

- **Title** (from the manifest): Yesteryear: Retro Time Machine for Searches
- **Summary** (from the manifest): Pick a year from 1998 to 2025: Google, YouTube and the whole web go back with you, in that year's look, with that year's hits.
- **Category:** Lifestyle > Just for Fun
- **Language:** English
- **Store icon:** `icon128.png`
- **Screenshots (1280x800, in this order):** `shot_card_2005.png`, `shot_trip.png`, `shot_google_2005.png`, `shot_altavista_1999.png`, `shot_tour_clippy.png`
- **Small promo tile (440x280):** `promo_small_440x280.png`
- **Marquee promo tile (1400x560):** `promo_marquee_1400x560.png`
- **Homepage URL:** https://github.com/neveleren/yesteryear
- **Support URL:** https://github.com/neveleren/yesteryear/issues

### Description

```
Pick a year. Google, YouTube and the whole web go back with you.

What did the internet say about phones before the iPhone? What was on Google News on this day in 2005? What was everyone googling in 2004? Set the dial to any year from 1998 to 2025, hit Travel, and search the way people did back then.

🚀 THE TRIP
"Travel to 2005 >>" is a ride, not a setting: a time tunnel, a date display rolling back from today, a flash, and you land on the card of your year, dressed like a computer of that time (Windows 98, XP, 7 or 10):
• the meme everyone is sharing and the No. 1 song on the radio
• what has already happened that year, and the gadget everyone wants
• what people are searching for: one click and you google it like it's that year
• the sites everyone visits (GeoCities, Napster, MySpace...), opened as they looked that very day
• today's front pages of CNN, BBC News and The New York Times, from that date
No spoilers: early in the year the card still shows last year's meme, because this year's has not happened yet.

🔎 GOOGLE, EXACTLY AS IT WAS
Eleven period looks, from the 1998 "Google!" beta to today, and your search really goes back:
• "best phones this year" becomes "best phones 2005", and Google's own date filter stops at your year
• results that give away a later date, or mention things that did not exist yet, are dropped
• sites that were not online yet are left out
• search for something from the future and Google tells you it has not happened yet
• I'm Feeling Lucky works like it used to; with an empty box it shows Google's holiday logos of the time

🌐 THE WEB OF THAT VERY DAY
Click a result and it opens from the Internet Archive as it looked in your year, never later. Google's own tabs work too: News, Groups, Gmail and "more" open those services as they were on today's date in your year. On the 1999 page, "Try your query on" takes you to AltaVista, Excite, Lycos and Yahoo! of 1999.

📺 YOUTUBE BEFORE IT GOT BIG
Searches only bring up videos uploaded by your year. Shorts, ads and the modern clutter are gone. Before 2005, YouTube simply doesn't exist yet.

🎵 THE SOUNDTRACK OF THE YEAR
The Billboard Year-End Hot 100 of your year, in the player of the time: Winamp, Windows Media Player, iTunes or Spotify. A mini player sits in the extension's window; hide the big player and the music keeps going.

📎 CLIPPY SHOWS YOU AROUND
On first start, Clippy (or Rover) walks you through every button.

GOOD TO KNOW
• Use a separate Chrome profile: while the time machine is ON, every Google search in that profile travels.
• Google decides dates by its own estimate, so a modern page can slip through now and then.
• Archived pages load at the Internet Archive's speed, and some old pictures were never saved.
• Free and open source: https://github.com/neveleren/yesteryear
• A hobby project, not affiliated with Google, YouTube, Microsoft or the Internet Archive. Clippy and Rover are Microsoft's characters.
```

## Privacy practices tab

**Single purpose:**
```
Browse Google, YouTube and the web as they were in a chosen past year (1998 to 2025): searches limited to that year, pages opened from the Internet Archive's copies of that time, the period look of Google and YouTube, and the year's music.
```

**Permission justifications:**

- **storage:** `Saves the chosen year and the settings, and caches archive lookups so the same page is not looked up twice.`
- **unlimitedStorage:** `The cache of archive lookups (which copy of a page and when a site was first archived) and of which video plays which song can grow beyond the default quota.`
- **declarativeNetRequestWithHostAccess:** `Three rules: (1) a result opened from a Google search page is sent to the extension's resolver page, which opens the Internet Archive's copy of that page from the chosen year; (2) form posts from archived Google sign-in pages are blocked, so nobody types a real password into an archive; (3) the extension's own YouTube music player embed gets a Referer header, without which YouTube does not serve the player.`
- **sidePanel:** `The music player (playlist of the year's hits) is shown in the side panel.`
- **webNavigation:** `Keeps archived pages inside the chosen year: when the Internet Archive jumps to a later copy, the extension opens the copy from the chosen year instead.`
- **tabs:** `Opens the welcome tour and the time-travel page, and reuses those tabs instead of opening new ones.`
- **offscreen:** `Plays the year's music (AUDIO_PLAYBACK) while the side panel is closed, so the player can be hidden.`
- **Host permissions:** `google.com and youtube.com: to apply the time machine to searches (date limit, period look). web.archive.org and archive.org: to look up and open archived copies. All http/https sites: needed by the redirect rule above, so that a result opened from a Google search can be sent to its archived copy; the rule acts only on navigations started from Google search pages.`

**Remote code:** No, I am not using remote code. (All scripts are in the package; archived pages and YouTube load in their own tabs and frames.)

**Data usage:** collected: **Web history** only (the addresses of search results the user opens, and the site names on a results page, are sent to the Internet Archive to find their copies). Certify all three: not sold to third parties, not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.

**Privacy policy URL:** https://github.com/neveleren/yesteryear/blob/main/PRIVACY.md

## Distribution tab
- Visibility: Public
- Regions: all
