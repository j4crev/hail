//! Operator prompts. Interactive prompts use the terminal; without one, answers come
//! from the answers file and a few values from environment variables.
use anyhow::{Context, Result, bail};
use inquire::validator::Validation;
use inquire::{Confirm, Select, Text};
use std::io::{BufRead, IsTerminal};

pub fn interactive() -> bool {
    std::io::stdin().is_terminal()
}

pub fn step(title: &str) {
    eprintln!("\n==> {title}");
}

pub fn info(message: &str) {
    eprintln!("    {message}");
}

pub fn text(
    prompt: &str,
    help: &str,
    check: fn(&str) -> bool,
    invalid: &'static str,
) -> Result<String> {
    Text::new(prompt)
        .with_help_message(help)
        .with_validator(move |value: &str| {
            Ok(if check(value.trim()) {
                Validation::Valid
            } else {
                Validation::Invalid(invalid.into())
            })
        })
        .prompt()
        .map(|value| value.trim().to_string())
        .context("cancelled")
}

pub fn confirm(prompt: &str, default: bool) -> Result<bool> {
    if !interactive() {
        return Ok(default);
    }
    Confirm::new(prompt)
        .with_default(default)
        .prompt()
        .context("cancelled")
}

pub fn choose<'a>(prompt: &str, options: Vec<&'a str>) -> Result<&'a str> {
    Select::new(prompt, options).prompt().context("cancelled")
}

fn eight_digits(value: &str) -> bool {
    value.len() == 8 && value.bytes().all(|b| b.is_ascii_digit())
}
fn code_or_resend(value: &str) -> bool {
    eight_digits(value) || value == "resend"
}

/// The emailed operator code: prompted, or read from HAILCTL_OPERATOR_CODE / one stdin line.
pub fn operator_code(email: &str) -> Result<String> {
    let valid = eight_digits;
    if let Ok(code) = std::env::var("HAILCTL_OPERATOR_CODE") {
        if valid(code.trim()) {
            return Ok(code.trim().to_string());
        }
        bail!("HAILCTL_OPERATOR_CODE must be the eight-digit code");
    }
    if interactive() {
        return text(
            &format!("Enter the eight-digit code emailed to {email}:"),
            "Type `resend` for a new code.",
            code_or_resend,
            "Enter the eight digits",
        );
    }
    eprintln!("Enter the eight-digit code emailed to {email}:");
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    let code = line.trim().to_string();
    if valid(&code) || code == "resend" {
        Ok(code)
    } else {
        bail!("expected the eight-digit code")
    }
}
