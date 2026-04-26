// Shared bench helpers for the worklets plugin.

use std::sync::Arc;

use swc_core::common::{FileName, SourceMap};
use swc_core::ecma::ast::Program;
use swc_core::ecma::parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax};

#[allow(dead_code)]
pub fn parse(code: &str) -> Program {
    let cm: Arc<SourceMap> = Default::default();
    let fm = cm.new_source_file(FileName::Anon.into(), code.to_string());
    let syntax = Syntax::Es(EsSyntax {
        jsx: true,
        ..Default::default()
    });
    let lexer = Lexer::new(syntax, Default::default(), StringInput::from(&*fm), None);
    let mut parser = Parser::new_from(lexer);
    parser.parse_program().expect("bench fixture must parse")
}
