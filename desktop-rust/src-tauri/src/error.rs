use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: &'static str,
}

impl Error {
    pub fn invalid() -> Self {
        Self {
            code: "invalid",
            message: "Solicitação inválida.",
        }
    }
    pub fn network() -> Self {
        Self {
            code: "network",
            message: "Não foi possível acessar o serviço. Tente novamente.",
        }
    }
    pub fn storage() -> Self {
        Self {
            code: "storage",
            message: "Não foi possível acessar a sessão protegida do Windows.",
        }
    }
    pub fn unauthorized() -> Self {
        Self {
            code: "unauthorized",
            message: "Entre novamente na sua conta.",
        }
    }
    pub fn unavailable(message: &'static str) -> Self {
        Self {
            code: "unavailable",
            message,
        }
    }
    pub fn clipboard() -> Self {
        Self {
            code: "clipboard",
            message: "Não foi possível copiar para a área de transferência.",
        }
    }
    pub fn unsupported() -> Self {
        Self {
            code: "unavailable",
            message: "Este recurso ainda não foi portado para a prévia Rust.",
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

// Do not forward raw network errors or response bodies: they can contain credentials/URLs.
pub fn api_error(status: u16, code: Option<&str>) -> Error {
    match code {
        Some("password_required") => Error {
            code: "password_required",
            message: "Digite a senha desta conta.",
        },
        Some("invalid_credentials") => Error {
            code: "invalid_credentials",
            message: "Nome ou senha incorretos.",
        },
        Some("nick_taken") => Error {
            code: "nick_taken",
            message: "Este nome já pertence a uma conta. Use o login original.",
        },
        Some("invalid_password") => Error {
            code: "invalid_password",
            message: "Use uma senha válida com pelo menos seis caracteres.",
        },
        Some("owner_cannot_leave") => Error {
            code: "owner_cannot_leave",
            message: "O proprietário precisa excluir o servidor para sair.",
        },
        _ => match status {
            401 => Error::unauthorized(),
            403 => Error {
                code: "forbidden",
                message: "Você não tem permissão para esta ação.",
            },
            404 => Error {
                code: "not_found",
                message: "Servidor ou convite não encontrado.",
            },
            410 => Error {
                code: "invite_invalid",
                message: "O convite expirou ou não é válido.",
            },
            413 => Error {
                code: "media_too_large",
                message: "A imagem excede o tamanho permitido.",
            },
            415 => Error {
                code: "unsupported_media",
                message: "Use uma imagem PNG, JPEG ou GIF válida.",
            },
            507 => Error {
                code: "media_storage_full",
                message: "O armazenamento de imagens do serviço está cheio.",
            },
            429 => Error {
                code: "rate_limited",
                message: "Muitas solicitações. Aguarde antes de tentar novamente.",
            },
            _ => Error::network(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn server_text_never_crosses_ipc() {
        let error = api_error(500, Some("token=secret-and-untrusted-text"));
        assert!(!serde_json::to_string(&error).unwrap().contains("secret"));
        assert_eq!(
            api_error(401, Some("password_required")).code,
            "password_required"
        );
    }
}
