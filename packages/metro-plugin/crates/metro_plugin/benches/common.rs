// Shared bench helpers: parse a JS string into a `Program` so each bench can
// time only the pass it cares about. Lives outside `src/` because it's only
// needed at bench time.

use std::sync::Arc;

use swc_core::common::{FileName, SourceMap};
use swc_core::ecma::ast::Program;
use swc_core::ecma::parser::{lexer::Lexer, Parser, StringInput, Syntax};

#[allow(dead_code)]
pub fn parse(code: &str) -> Program {
    let cm: Arc<SourceMap> = Default::default();
    let fm = cm.new_source_file(FileName::Anon.into(), code.to_string());
    let lexer = Lexer::new(
        Syntax::Es(Default::default()),
        Default::default(),
        StringInput::from(&*fm),
        None,
    );
    let mut parser = Parser::new_from(lexer);
    parser.parse_program().expect("bench fixture must parse")
}
