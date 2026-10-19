#pragma once
#include <QString>
#include <QJsonObject>

class QWidget;

namespace triscord {

class AuthSession;

// Opens the "Editar perfil" screen (profile editor), reachable from the
// account popover. Loads the signed-in account's current profile via
// GET /me on open, lets the user edit the free-tier profile fields
// (cloudflare-auth/src/worker.js PROFILE_FIELDS), and on "Salvar" sends only
// the fields that changed via PATCH /profile. On a 401 response the session
// is cleared (AuthSession::clearSession()) since the session is dead.
//
// Returns true if the profile was saved (at least one field changed and the
// PATCH succeeded), false if the user cancelled or the dialog could not load.
bool openProfileEditDialog(QWidget* parent, AuthSession& session);

// --- Exposed for tests -----------------------------------------------------

// Validates a single field's candidate value against the same limits the
// server enforces (cloudflare-auth/src/worker.js PROFILE_FIELDS). Returns an
// empty string when the value is acceptable, or a short Portuguese message
// to show the user otherwise. `value` may be empty (clears the field).
QString validateProfileField(const QString& key, const QString& value);

// Builds the PATCH /profile request body: only keys whose value in `current`
// differs from `original` are included (both objects use the same field
// names as PROFILE_FIELDS; a key absent from `original` is treated as null).
QJsonObject buildProfilePatchBody(const QJsonObject& original, const QJsonObject& current);

} // namespace triscord
