#pragma once

namespace triscord {

// Loads the fonts embedded from desktop/assets/fonts-local (gitignored; see desktop/assets/fonts-local/README.md).
// Safe to call more than once; does nothing when the build did not embed any.
void loadBundledFonts();

} // namespace triscord
