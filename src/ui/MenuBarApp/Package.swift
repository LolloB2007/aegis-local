// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AegisMenuBar",
    products: [
        .executable(
            name: "AegisMenuBar",
            targets: ["AegisMenuBar"]
        ),
    ],
    targets: [
        .executableTarget(
            name: "AegisMenuBar",
            dependencies: [],
            resources: [
                .process("Resources")
            ]
        )
    ]
)