#pragma once
#include "video_codec.h"
#include <QImage>
namespace triscord { QImage videoImage(const DecodedVideo& video, QSize limit); }
