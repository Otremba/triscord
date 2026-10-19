#pragma once
#include <QString>

class QWidget;

namespace triscord {

// Prompts a newly-registered Google account for a nick (POST /nick), keeping
// the dialog open with a readable message on a duplicate-nick error. Returns
// the chosen nick on success, or an empty string if the user cancelled.
// `postNick` should perform the POST /nick call and return either the
// accepted nick (success) or an empty optional with `*errorOut` set.
QString chooseNickDialog(QWidget* parent, const QString& sessionToken, const QString& suggestedNick);

} // namespace triscord
