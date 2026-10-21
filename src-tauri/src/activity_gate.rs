use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

#[derive(Default)]
struct GateState {
    active: usize,
    installing: bool,
}

pub struct ActivityGate {
    state: Mutex<GateState>,
    dictation: Mutex<Option<ActivityPermit>>,
}

#[must_use = "dropping an ActivityPermit releases it immediately"]
pub struct ActivityPermit {
    gate: Arc<ActivityGate>,
}

#[must_use = "dropping an InstallGuard ends the install window immediately"]
pub struct InstallGuard {
    gate: Arc<ActivityGate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstallInProgress;

impl fmt::Display for InstallInProgress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an update install is in progress")
    }
}

impl std::error::Error for InstallInProgress {}

impl ActivityGate {
    pub fn new() -> Arc<ActivityGate> {
        Arc::new(ActivityGate {
            state: Mutex::new(GateState::default()),
            dictation: Mutex::new(None),
        })
    }

    /// Grants a permit unless an update install is in progress.
    pub fn try_acquire(self: &Arc<Self>) -> Result<ActivityPermit, InstallInProgress> {
        let mut state = self.state();
        if state.installing {
            return Err(InstallInProgress);
        }
        state.active += 1;
        Ok(ActivityPermit {
            gate: Arc::clone(self),
        })
    }

    /// Succeeds only when no permit is live (a parked dictation permit counts) and no
    /// other install is in progress. New permits are refused until the guard drops.
    #[must_use = "dropping the InstallGuard ends the install window immediately"]
    pub fn try_begin_install(self: &Arc<Self>) -> Option<InstallGuard> {
        let mut state = self.state();
        if state.active > 0 || state.installing {
            return None;
        }
        state.installing = true;
        Some(InstallGuard {
            gate: Arc::clone(self),
        })
    }

    /// Holds one recording's permit until the stop handler takes it. A permit already
    /// parked is replaced and released.
    pub fn park_dictation(&self, permit: ActivityPermit) {
        let replaced = self.dictation().replace(permit);
        drop(replaced);
    }

    pub fn take_dictation(&self) -> Option<ActivityPermit> {
        self.dictation().take()
    }

    pub fn drop_dictation(&self) {
        let parked = self.dictation().take();
        drop(parked);
    }

    fn state(&self) -> MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn dictation(&self) -> MutexGuard<'_, Option<ActivityPermit>> {
        self.dictation
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl ActivityPermit {
    /// Keeps the permit held on a background thread for `delay`, then releases it.
    pub fn release_after(self, delay: Duration) {
        thread::spawn(move || {
            thread::sleep(delay);
            drop(self);
        });
    }
}

impl Drop for ActivityPermit {
    fn drop(&mut self) {
        self.gate.state().active -= 1;
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        self.gate.state().installing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Instant;

    #[test]
    fn install_refused_while_permit_held() {
        let gate = ActivityGate::new();
        let _permit = gate.try_acquire().expect("acquire with no install");
        assert!(gate.try_begin_install().is_none());
    }

    #[test]
    fn install_allowed_after_permit_dropped() {
        let gate = ActivityGate::new();
        let permit = gate.try_acquire().expect("acquire with no install");
        drop(permit);
        assert!(gate.try_begin_install().is_some());
    }

    #[test]
    fn acquire_refused_while_installing() {
        let gate = ActivityGate::new();
        let _guard = gate.try_begin_install().expect("install on idle gate");
        assert_eq!(gate.try_acquire().err(), Some(InstallInProgress));
    }

    #[test]
    fn second_install_refused_while_first_in_progress() {
        let gate = ActivityGate::new();
        let _guard = gate.try_begin_install().expect("install on idle gate");
        assert!(gate.try_begin_install().is_none());
    }

    #[test]
    fn install_guard_drop_reopens_gate() {
        let gate = ActivityGate::new();
        let guard = gate.try_begin_install().expect("install on idle gate");
        drop(guard);
        let permit = gate.try_acquire().expect("acquire after failed install");
        drop(permit);
        assert!(gate.try_begin_install().is_some());
    }

    #[test]
    fn parked_dictation_blocks_install_until_taken_and_dropped() {
        let gate = ActivityGate::new();
        gate.park_dictation(gate.try_acquire().expect("acquire"));
        assert!(gate.try_begin_install().is_none());

        let taken = gate.take_dictation().expect("parked permit");
        assert!(gate.take_dictation().is_none());
        assert!(gate.try_begin_install().is_none());
        drop(taken);
        assert!(gate.try_begin_install().is_some());

        gate.park_dictation(gate.try_acquire().expect("acquire"));
        assert!(gate.try_begin_install().is_none());
        gate.drop_dictation();
        assert!(gate.take_dictation().is_none());
        assert!(gate.try_begin_install().is_some());
    }

    #[test]
    fn parking_over_a_parked_permit_releases_the_replaced_one() {
        let gate = ActivityGate::new();
        gate.park_dictation(gate.try_acquire().expect("first acquire"));
        gate.park_dictation(gate.try_acquire().expect("second acquire"));
        gate.drop_dictation();
        assert!(gate.try_begin_install().is_some());
    }

    #[test]
    fn release_after_holds_until_delay() {
        let delay = Duration::from_millis(50);
        let gate = ActivityGate::new();
        let start = Instant::now();
        gate.try_acquire().expect("acquire").release_after(delay);

        thread::sleep(Duration::from_millis(10));
        assert!(gate.try_begin_install().is_none());

        let deadline = start + Duration::from_secs(2);
        let freed_at = loop {
            if let Some(guard) = gate.try_begin_install() {
                drop(guard);
                break start.elapsed();
            }
            assert!(
                Instant::now() < deadline,
                "permit was not released within 2 s"
            );
            thread::sleep(Duration::from_millis(2));
        };
        assert!(
            freed_at >= delay,
            "permit released after {freed_at:?}, before the {delay:?} delay"
        );
    }

    #[test]
    fn concurrent_acquire_and_install_never_both_succeed() {
        const THREADS: usize = 8;
        const ITERATIONS: usize = 1000;

        let gate = ActivityGate::new();
        let live_permits = Arc::new(AtomicUsize::new(0));
        let install_live = Arc::new(AtomicBool::new(false));
        let acquires = Arc::new(AtomicUsize::new(0));
        let installs = Arc::new(AtomicUsize::new(0));

        let handles: Vec<_> = (0..THREADS)
            .map(|t| {
                let gate = Arc::clone(&gate);
                let live_permits = Arc::clone(&live_permits);
                let install_live = Arc::clone(&install_live);
                let acquires = Arc::clone(&acquires);
                let installs = Arc::clone(&installs);
                thread::spawn(move || {
                    for i in 0..ITERATIONS {
                        if (t + i) % 2 == 0 {
                            if let Ok(permit) = gate.try_acquire() {
                                live_permits.fetch_add(1, Ordering::SeqCst);
                                assert!(
                                    !install_live.load(Ordering::SeqCst),
                                    "permit granted while an install guard is live"
                                );
                                acquires.fetch_add(1, Ordering::SeqCst);
                                thread::yield_now();
                                live_permits.fetch_sub(1, Ordering::SeqCst);
                                drop(permit);
                            }
                        } else if let Some(guard) = gate.try_begin_install() {
                            assert!(
                                !install_live.swap(true, Ordering::SeqCst),
                                "two install guards live at once"
                            );
                            assert_eq!(
                                live_permits.load(Ordering::SeqCst),
                                0,
                                "install guard granted while a permit is live"
                            );
                            installs.fetch_add(1, Ordering::SeqCst);
                            thread::yield_now();
                            install_live.store(false, Ordering::SeqCst);
                            drop(guard);
                        }
                    }
                })
            })
            .collect();

        for handle in handles {
            handle.join().expect("worker thread panicked");
        }

        assert!(
            acquires.load(Ordering::SeqCst) > 0,
            "no permit was ever granted"
        );
        assert!(
            installs.load(Ordering::SeqCst) > 0,
            "no install was ever granted"
        );
        assert!(
            gate.try_begin_install().is_some(),
            "gate did not return to idle"
        );
    }
}
