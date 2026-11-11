// Yesteryear service worker: one module per feature, each registers its own listeners synchronously.
// Contract for all modules: see ../ARCHITECTURE.md (state keys, message types, DNR rule id ranges).
import { initState } from "./src/shared/state_sw.js";
import { initUI } from "./src/ui/sw_ui.js";
import { initWayback } from "./src/wayback/sw_wayback.js";
import { initMusic } from "./src/player/sw_music.js";
import { initGoogle } from "./src/google/sw_google.js";
import { initTour } from "./src/tour/sw_tour.js";
import { initTravel } from "./src/travel/sw_travel.js";

initState();
initUI();
initWayback();
initMusic();
initGoogle();
initTour();
initTravel();
