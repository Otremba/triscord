#pragma once
// No TLS debug instrumentation in the application. Also avoids the upstream
// Windows debug printf format mismatch with MinGW's ANSI stdio implementation.
#undef MBEDTLS_DEBUG_C
#define MBEDTLS_SSL_DTLS_SRTP
