use crate::{VncError, VncEvent};
use tokio::sync::{mpsc::Sender, oneshot};

pub(super) async fn report_error(
    error: VncError,
    output: &Sender<VncEvent>,
    stop: &mut oneshot::Receiver<()>,
) {
    let message = match &error {
        // The network bridge closes with EOF on normal disconnection.
        VncError::IoError(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return,
        VncError::IoError(error) => error.to_string(),
        error => error.to_string(),
    };
    tracing::error!("Error occurs during the decoding {:?}", error);
    tokio::select! {
        biased;
        _ = stop => {},
        _ = output.send(VncEvent::Error(message)) => {},
    }
}
