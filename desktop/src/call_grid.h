#pragma once
#include <QRect>
#include <algorithm>
#include <cmath>

namespace triscord {
// Port of recovered frontend module 511205: 16:9 tiles, 8px gaps,
// binary search for the largest tile width that fits the viewport.
struct CallGrid {
    int columns = 1;
    int rows = 0;
    int tileWidth = 0;
    int tileHeight = 0;
    int top = 0;
    // Observed in Discord (CALLS.md): the grid is centred horizontally in the call area.
    int left = 8;
    QRect tile(int index) const {
        return {left + (index % columns) * (tileWidth + 8),
                top + (index / columns) * (tileHeight + 8), tileWidth, tileHeight};
    }
};
inline CallGrid callGrid(int count, int width, int height) {
    if (count <= 0 || width <= 16 || height <= 0) return {};
    const int available = width - 16;
    auto columns = [available](int tile) { return std::max(1, (available + 8) / (tile + 8)); };
    int low = available / 25, high = available;
    while (low < high) {
        const int candidate = low + (high - low) / 2;
        const double tileHeight = candidate * 9.0 / 16.0;
        const double rows = count > 25 ? std::ceil((height - tileHeight) / (8 + tileHeight)) + 1
                                       : std::floor((height - tileHeight) / (8 + tileHeight)) + 1;
        const bool fits = count > 25 ? columns(candidate) * rows > 25 : columns(candidate) * rows >= count;
        if (fits) low = candidate + 1; else high = candidate;
    }
    const int tileWidth = std::max(1, low - 1);
    const int cols = columns(tileWidth), rows = (count + cols - 1) / cols;
    const int tileHeight = tileWidth * 9 / 16;
    const int used = cols * tileWidth + (cols - 1) * 8;
    return {cols, rows, tileWidth, tileHeight, std::max(0, height - (tileHeight + 8) * rows) / 2, std::max(8, (width - used) / 2)};
}
}
