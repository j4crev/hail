//! hailctl: install and operate a Hail provider from a signed release.
mod backup;
mod compose;
mod dns;
mod host;
mod install;
mod recovery;
mod register;
mod release;
mod s3;
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
        #[arg(long, conflicts_with = "restore")]
        answers: Option<PathBuf>,
        /// Restore a provider from a hailctl backup instead of creating a new one
        /// (moving servers or disaster recovery). Reads KEY_ENCRYPTION_KEY from
        /// HAILCTL_KEY_ENCRYPTION_KEY or a prompt.
        #[arg(long, value_name = "FILE", conflicts_with = "release")]
        restore: Option<PathBuf>,
    },
    /// Upgrade to a newer provider release, backing up first.
    Upgrade {
        /// Provider release tag (default: the latest).
        #[arg(long)]
        release: Option<String>,
    },
    /// Return to the release and data from before the last upgrade.
    Rollback {
        /// Proceed without asking for confirmation.
        #[arg(long)]
        yes: bool,
    },
    /// Replace this provider's data (and release) with a backup's.
    Restore {
        file: PathBuf,
        /// Proceed without asking for confirmation.
        #[arg(long)]
        yes: bool,
    },
    /// Back up the database and configuration (without a subcommand), or manage backups.
    Backup {
        #[command(subcommand)]
        command: Option<Backup>,
        /// Run by the daily timer.
        #[arg(long, hide = true)]
        scheduled: bool,
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
enum Backup {
    /// List local backups, the timer and the off-host bucket.
    List,
    /// Copy every backup to an S3-compatible bucket (R2, B2, S3, MinIO).
    Configure {
        /// Read the settings from a TOML file instead of prompting.
        #[arg(long, value_name = "FILE")]
        from: Option<PathBuf>,
        /// Stop copying backups off-host.
        #[arg(long, conflicts_with = "from")]
        remove: bool,
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
        Command::Install {
            release,
            answers,
            restore,
        } => install::install(&install::Options {
            dir: cli.dir,
            release,
            answers,
            restore,
        }),
        Command::Upgrade { release } => recovery::upgrade(&cli.dir, release),
        Command::Rollback { yes } => recovery::rollback(&cli.dir, yes),
        Command::Restore { file, yes } => recovery::restore(&cli.dir, &file, yes),
        Command::Backup {
            command: None,
            scheduled,
        } => recovery::backup(&cli.dir, scheduled),
        Command::Backup {
            command: Some(Backup::List),
            ..
        } => recovery::list(&cli.dir),
        Command::Backup {
            command: Some(Backup::Configure { from, remove }),
            ..
        } => recovery::configure(&cli.dir, from, remove),
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
