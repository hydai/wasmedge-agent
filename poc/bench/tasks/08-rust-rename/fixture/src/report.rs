use crate::{calc_total, Entry};

pub fn summary(entries: &[Entry]) -> String {
    format!("total={}", calc_total(entries))
}
