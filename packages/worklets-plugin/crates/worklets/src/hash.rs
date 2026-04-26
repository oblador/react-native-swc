/// djb2 xor variant – mirrors the hash in the Babel plugin.
pub fn worklet_hash(s: &str) -> u64 {
    let bytes = s.as_bytes();
    let mut i = bytes.len();
    let mut hash1: u64 = 5381;
    let mut hash2: u64 = 52711;

    while i > 0 {
        i -= 1;
        let c = bytes[i] as u64;
        hash1 = (hash1.wrapping_mul(33)) ^ c;
        hash2 = (hash2.wrapping_mul(33)) ^ c;
    }

    (hash1 & 0xFFFFFFFF)
        .wrapping_mul(4096)
        .wrapping_add(hash2 & 0xFFFFFFFF)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic() {
        let h = worklet_hash("function foo(){return 1;}");
        assert_eq!(h, worklet_hash("function foo(){return 1;}"));
        assert_ne!(h, worklet_hash("function foo(){return 2;}"));
    }
}
