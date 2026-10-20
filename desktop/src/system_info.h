#pragma once

namespace triscord {
// Writes the computer a log comes from (20/10): Windows release, CPU, memory, every GPU with its driver, and the
// monitors. Decoder, capture and encoder bugs depend on exactly these, and a report no longer needs to ask for them.
// Hardware names only: no user, computer or device-instance names. Needs a QGuiApplication for the monitors.
void logSystemInfo();
}
