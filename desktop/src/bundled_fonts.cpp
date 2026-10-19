#include "bundled_fonts.h"

#include <QDir>
#include <QFontDatabase>

#ifdef TRISCORD_LOCAL_FONTS
static void initializeLocalFonts() { Q_INIT_RESOURCE(fonts_local); }
#endif

namespace triscord {

void loadBundledFonts() {
#ifdef TRISCORD_LOCAL_FONTS
    static const bool loaded = [] {
        initializeLocalFonts();
        const auto files = QDir(":/fonts").entryList({"*.ttf"}, QDir::Files);
        for (const auto& file : files) QFontDatabase::addApplicationFont(":/fonts/" + file);
        return !files.isEmpty();
    }();
    Q_UNUSED(loaded);
#endif
}

} // namespace triscord
