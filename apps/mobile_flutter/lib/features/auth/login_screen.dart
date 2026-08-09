import 'package:flutter/material.dart';

import 'package:mbs_mobile_flutter/core/auth/auth_controller.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.authController,
  });

  final AuthController authController;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _baseUrl = TextEditingController(text: 'http://localhost:3001');
  final _orgSlug = TextEditingController(text: 'russell-comfort');
  final _identifier = TextEditingController();
  final _pin = TextEditingController();
  bool _submitting = false;
  bool _showAdvanced = false;
  String? _error;

  @override
  void dispose() {
    _baseUrl.dispose();
    _orgSlug.dispose();
    _identifier.dispose();
    _pin.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });

    try {
      await widget.authController.loginWithPin(
        apiBaseUrl: _baseUrl.text.trim(),
        orgSlug: _orgSlug.text.trim(),
        identifier: _identifier.text.trim(),
        pin: _pin.text.trim(),
        deviceName: 'iPhone',
      );

      final session = widget.authController.session.value;
      if (session?.mobilePinResetRequired == true) {
        await widget.authController.signOut();
        setState(() {
          _error = 'PIN reset required. Contact admin/manager to set your mobile PIN.';
        });
      }
    } catch (error) {
      setState(() {
        _error = error.toString();
      });
    } finally {
      if (mounted) {
        setState(() {
          _submitting = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('MBS Mobile PIN Login')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Form(
            key: _formKey,
            child: ListView(
              children: [
                TextFormField(
                  controller: _orgSlug,
                  decoration: const InputDecoration(labelText: 'Organization Slug'),
                  validator: (value) =>
                      (value == null || value.trim().isEmpty) ? 'Required' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _identifier,
                  decoration: const InputDecoration(
                    labelText: 'Email, Phone, or Employee ID',
                  ),
                  validator: (value) =>
                      (value == null || value.trim().isEmpty) ? 'Required' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _pin,
                  keyboardType: TextInputType.number,
                  obscureText: true,
                  maxLength: 6,
                  decoration: const InputDecoration(labelText: 'PIN (4-6 digits)'),
                  validator: (value) {
                    final pin = (value ?? '').trim();
                    if (!RegExp(r'^\d{4,6}$').hasMatch(pin)) {
                      return 'Enter a valid 4-6 digit PIN';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 8),
                TextButton(
                  onPressed: () {
                    setState(() {
                      _showAdvanced = !_showAdvanced;
                    });
                  },
                  child: Text(_showAdvanced ? 'Hide Advanced' : 'Show Advanced'),
                ),
                if (_showAdvanced) ...[
                  const SizedBox(height: 8),
                  TextFormField(
                    controller: _baseUrl,
                    decoration: const InputDecoration(labelText: 'API Base URL (dev)'),
                    validator: (value) {
                      if (!_showAdvanced) return null;
                      return (value == null || value.trim().isEmpty)
                          ? 'Required'
                          : null;
                    },
                  ),
                ],
                const SizedBox(height: 20),
                FilledButton(
                  onPressed: _submitting ? null : _submit,
                  child: Text(_submitting ? 'Signing in...' : 'Sign In'),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
