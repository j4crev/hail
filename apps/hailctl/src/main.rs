//! hailctl: install and operate a Hail provider from a signed release.
mod compose;
mod dns;
mod host;
mod install;
mod register;
mod release;
mod state;
mod ui;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "hailctl",
    version,
    about = "Install and operate a Hail provider"
)]
struct Cli {
    /// Installation directory.
    #[arg(long, global = true, default_value = state::DEFAULT_DIR)]
    dir: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Install a provider on this server, or resume an interrupted install.
    Install {
        /// Provider release tag, such as provider-v0.2.0 (default: the latest).
        #[arg(long)]
        release: Option<String>,
        /// TOML answers file for unattended installs.
        #[arg(long)]
        answers: Option<PathBuf>,
    },
    /// Upgrade to a newer provider release.
    Upgrade {
        /// Provider release tag (default: the latest).
        #[arg(long)]
        release: Option<String>,
    },
    /// Show the installed release and service health.
    Status,
    /// Administrator commands.
    Admin {
        #[command(subcommand)]
        command: Admin,
    },
    /// Provider service accounts (reserved addresses such as abuse@).
    ServiceAccount {
        #[command(subcommand)]
        command: ServiceAccount,
    },
}

#[derive(Subcommand)]
enum Admin {
    /// Print a single-use, ten-minute passkey enrollment link for admin@.
    PasskeyLink,
}

#[derive(Subcommand)]
enum ServiceAccount {
    /// Create (or resume creating) a reserved service account, such as abuse.
    Create { name: String },
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Install { release, answers } => install::install(&install::Options {
            dir: cli.dir,
            release,
            answers,
        }),
        Command::Upgrade { release } => install::upgrade(&cli.dir, release),
        Command::Status => install::status(&cli.dir),
        Command::Admin {
            command: Admin::PasskeyLink,
        } => install::admin_link(&cli.dir),
        Command::ServiceAccount {
            command: ServiceAccount::Create { name },
        } => install::service_account(&cli.dir, &name),
    };
    if let Err(error) = result {
        eprintln!("hailctl: {error:#}");
        std::process::exit(1);
    }
}
