pub mod report;

pub struct Entry {
    pub amount: i64,
}

/// Sum of all entry amounts.
pub fn calc_total(entries: &[Entry]) -> i64 {
    entries.iter().map(|e| e.amount).sum()
}
